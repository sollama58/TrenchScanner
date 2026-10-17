import { prisma } from "../db.js";
import type { FilterCriteria } from "../types.js";
import { parseModelGate, type ModelGates } from "./modelGate.js";

/** The model gates' reads (curation/modelGate.ts), apart so the training thread never loads the client. */

/** A frozen gate as stored, with where it came from. */
export interface StoredModelGate {
  id: string;
  criteria: FilterCriteria;
  sourceFilterId: string;
  sourceFilterName: string;
  sourceCriteriaChangedAt: Date | null;
  frozenAt: Date;
}

/** Every frozen gate (ModelGate). A row whose criteria don't parse is left out. */
export async function loadModelGates(): Promise<StoredModelGate[]> {
  const rows = await prisma.modelGate.findMany();
  return rows.flatMap((r) => {
    const criteria = parseModelGate(r.criteria);
    return criteria === null ? [] : [{ ...r, criteria }];
  });
}

/** loadModelGates as the map training and the live roster read. */
export function gatesById(gates: readonly StoredModelGate[]): ModelGates {
  return Object.fromEntries(gates.map((g) => [g.id, g.criteria]));
}
