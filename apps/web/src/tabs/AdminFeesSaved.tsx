import { useState } from "react";
import { usePolling } from "../hooks";
import { usd } from "../format";
import { ShareButton } from "../components/ShareImageDialog";
import {
  feeText,
  readOtherNetwork,
  renderFeesCard,
  saveOtherNetwork,
  withOtherNetwork,
  type FeesPlatform,
} from "./feesCard";
import { Kpi, Load, Panel, Table, when } from "./adminShared";

/** Mirrors apps/api/src/routes/adminProMode.ts GET /admin/pro-mode/fees-saved. */
interface FeesSavedTotal {
  trades: number;
  buys: number;
  sells: number;
  volumeSol: number;
  platformFeeSol: number;
  networkFeeSol: number;
  ratesAsOf: string;
  otherNetwork: { gasSol: number; priorityFeeSol: number; perTradeSol: number; totalSol: number };
  platforms: FeesPlatform[];
  wallets: number;
  since: string | null;
  solUsd: number | null;
}

/**
 * Admin > Access > Total fees saved (user ask 2026-10-24): every wallet's Trade panel trades
 * together, priced against other platforms as each wallet's Portfolio page prices its own, with
 * the same gas and priority fee toggle and a share image of the total.
 */
export function FeesSavedAdmin() {
  const q = usePolling<FeesSavedTotal>("/admin/pro-mode/fees-saved", 60_000);
  const [withNetwork, setWithNetwork] = useState(readOtherNetwork);
  const raw = q.data;
  const data = raw && { ...raw, platforms: withOtherNetwork(raw.platforms, withNetwork) };
  const best = data?.platforms.reduce((a, b) => (b.savedSol > a.savedSol ? b : a), data.platforms[0]!);
  const inUsd = (v: number) => (data?.solUsd ? ` · ${usd(v * data.solUsd)}` : "");
  return (
    <Panel
      title="Total fees saved"
      note="Every wallet's confirmed trades from the Trade panel, against what the same trades would pay in fees on each other platform."
      actions={
        data &&
        data.trades > 0 &&
        best && (
          <ShareButton
            title="Total fees saved"
            fileName="trenchscanner-fees-saved-total"
            caption="What trading on TrenchScanner has saved traders in fees"
            render={() =>
              renderFeesCard(
                {
                  ...data,
                  otherNetwork: withNetwork
                    ? { gasSol: data.otherNetwork.gasSol, priorityFeeSol: data.otherNetwork.priorityFeeSol }
                    : undefined,
                },
                {
                  title: "What TrenchScanner saved its traders",
                  subtitle:
                    "Every trade made on TrenchScanner, against the fees the same trades would pay elsewhere.",
                  badge: `${data.wallets.toLocaleString("en-US")} trader${data.wallets === 1 ? "" : "s"}`,
                },
              )
            }
          />
        )
      }
    >
      <Load q={q}>
        {() =>
          !data || data.trades === 0 ? (
            <p className="muted small">No confirmed trades from the Trade panel yet.</p>
          ) : (
            <>
              <label className="check small">
                <input
                  type="checkbox"
                  checked={withNetwork}
                  onChange={(e) => {
                    setWithNetwork(e.target.checked);
                    saveOtherNetwork(e.target.checked);
                  }}
                />{" "}
                Include gas ({data.otherNetwork.gasSol} SOL) and priority fee (
                {data.otherNetwork.priorityFeeSol} SOL) on each buy and sale elsewhere
              </label>
              <div className="kpis">
                {best && (
                  <Kpi
                    label={`Saved vs ${best.name}`}
                    value={feeText(best.savedSol)}
                    sub={`the most saved against any platform${inUsd(best.savedSol)}`}
                    tone={best.savedSol >= 0 ? "ok" : "warn"}
                  />
                )}
                <Kpi
                  label="Traders"
                  value={data.wallets.toLocaleString()}
                  sub={`since ${when(data.since)}`}
                />
                <Kpi
                  label="Trades"
                  value={data.trades.toLocaleString()}
                  sub={`${data.buys} buys / ${data.sells} sales`}
                />
                <Kpi
                  label="Volume"
                  value={feeText(data.volumeSol)}
                  sub={data.solUsd ? usd(data.volumeSol * data.solUsd) : undefined}
                />
              </div>
              <Table
                head={["Platform", "Their fees", "Est. saved"]}
                rows={data.platforms.map((p) => [
                  p.estimate ? `${p.name} (estimate)` : p.name,
                  feeText(p.feeSol),
                  `${feeText(p.savedSol)}${inUsd(p.savedSol)}`,
                ])}
              />
              <p className="faint small">
                TrenchScanner&apos;s own fees on these trades: {feeText(data.platformFeeSol)} platform,{" "}
                {feeText(data.networkFeeSol)} network.
              </p>
            </>
          )
        }
      </Load>
    </Panel>
  );
}
