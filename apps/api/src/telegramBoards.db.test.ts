// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "./bootstrap-env.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@trenchscanner/core";
import { createTelegramBoards } from "./telegramBoards.js";

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);

const TAG = `tgboards-test-${Date.now()}`;

describe.skipIf(!dbAvailable)("Telegram boards", () => {
  let chatRowId = "";
  let tokenId = "";
  let rulesId = "";
  let treesId = "";
  const sentAt = new Date(Date.now() - 2 * 3_600_000);

  beforeAll(async () => {
    const user = await prisma.user.create({ data: { walletAddress: `${TAG}-wallet` } });
    chatRowId = (
      await prisma.telegramChat.create({
        data: {
          chatId: BigInt(-4_000_000_000_000 - Math.floor(Math.random() * 1e6)),
          kind: "private",
          userId: user.id,
        },
      })
    ).id;
    tokenId = (await prisma.token.create({ data: { mintAddress: `${TAG}-mint`, symbol: "TB" } })).id;
    const call = (model: string, minutesBefore: number, won: boolean) =>
      prisma.curatedAlert.create({
        data: {
          tokenId,
          source: TAG,
          confidence: 80,
          anchorPriceUsd: 1,
          anchorMcapUsd: won ? 10_000 : 30_000,
          model,
          modelName: model,
          createdAt: new Date(sentAt.getTime() - minutesBefore * 60_000),
          hit2xIn1h: won,
          hit4xIn1h: false,
          disqualified: false,
          outcomeFinalizedAt: sentAt,
        },
      });
    // Rules called first and doubled; the chat follows Trees, which called later and didn't.
    rulesId = (await call("rules", 3, true)).id;
    treesId = (await call("trees", 1, false)).id;
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { walletAddress: `${TAG}-wallet` } });
    await prisma.token.deleteMany({ where: { mintAddress: `${TAG}-mint` } });
  });

  it("grades a send by the call it carried, and counts a re-alert as a send of its own", async () => {
    const boards = createTelegramBoards();
    await prisma.telegramAlertSent.create({
      data: { chatId: chatRowId, tokenId, sentAt, curatedAlertId: treesId },
    });
    let board = await boards.board(chatRowId, 24);
    expect(board).toMatchObject({ alerts: 1, graded: 1, won: 0 });

    // A row from before sends were recorded falls back to the earliest call around it (Rules).
    await prisma.telegramAlertSent.deleteMany({ where: { chatId: chatRowId } });
    await prisma.telegramAlertSent.create({ data: { chatId: chatRowId, tokenId, sentAt } });
    board = await boards.board(chatRowId, 24);
    expect(board).toMatchObject({ alerts: 1, won: 1 });

    // Two sends of the token are two alerts on the board.
    await prisma.telegramAlertSent.create({
      data: {
        chatId: chatRowId,
        tokenId,
        sentAt: new Date(sentAt.getTime() + 60_000),
        curatedAlertId: rulesId,
      },
    });
    board = await boards.board(chatRowId, 24);
    expect(board.alerts).toBe(2);
  });

  it("reads one send as it stands now for the Refresh button, asking for a fresh price first", async () => {
    const at = new Date(sentAt.getTime() + 120_000);
    await prisma.telegramAlertSent.create({
      data: { chatId: chatRowId, tokenId, sentAt: at, curatedAlertId: treesId },
    });
    const readAt = new Date(Date.now() - 5_000);
    await prisma.token.update({
      where: { id: tokenId },
      data: { liveMarketCapUsd: 60_000, liveDataAt: readAt },
    });
    await prisma.tokenSnapshot.create({
      data: {
        tokenId,
        takenAt: new Date(Date.now() - 60_000),
        priceUsd: 1,
        marketCapUsd: 50_000,
        rugScreenPassed: true,
        holderCount: 321,
        volume1hUsd: 7_000,
      },
    });
    const asked: string[] = [];
    const boards = createTelegramBoards(Date.now, {
      liveRefresher: {
        refreshAndWait: async (tokens, opts) => {
          asked.push(`${tokens.map((t) => t.id).join()}:${opts.userKey}`);
          return true;
        },
      },
    });
    const now = await boards.alertNow!(chatRowId, tokenId, at);
    expect(asked).toEqual([`${tokenId}:telegram:${chatRowId}`]);
    expect(now).toMatchObject({
      token: { mintAddress: `${TAG}-mint`, symbol: "TB" },
      holderCount: 321,
      volume1hUsd: 7_000,
      // Trees' anchor, which the card led with; the live reading is newer than the snapshot.
      alertMcapUsd: 30_000,
      nowMcapUsd: 60_000,
      peakPct: 100,
    });
    // A send this chat never got is nothing.
    expect(await boards.alertNow!(chatRowId, tokenId, new Date(at.getTime() + 1))).toBeNull();
    expect(await boards.alertNow!(chatRowId, `${TAG}-missing`, at)).toBeNull();
  });
});
