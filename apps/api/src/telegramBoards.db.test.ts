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
});
