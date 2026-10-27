/**
 * The store listing's promises against the manifest (audit EX-2): every permission the manifest asks
 * for has a justification in STORE.md and is named in the privacy policy, and the extension asks for
 * no host access, which both say it doesn't. build.mjs refuses a store package that breaks one, and
 * store.test.mjs runs the same check in CI.
 */

/** How the privacy policy names each permission it explains. A new permission needs a line here. */
export const POLICY_NAMES = {
  storage: "storage",
  sidePanel: "the side panel",
  notifications: "notifications",
  alarms: "alarms",
};

/** What STORE.md or the privacy policy leaves unjustified in `manifest`; empty when they agree. */
export function storePolicyGaps(manifest, storeMd, privacyHtml) {
  const gaps = [];
  const policy = privacyHtml.replace(/\s+/g, " ");
  for (const permission of manifest.permissions ?? []) {
    if (!storeMd.includes(`- \`${permission}\`:`))
      gaps.push(`STORE.md has no justification for ${permission}`);
    const named = POLICY_NAMES[permission];
    if (!named || !policy.includes(named)) gaps.push(`the privacy policy doesn't name ${permission}`);
  }
  for (const key of ["host_permissions", "optional_host_permissions", "optional_permissions"]) {
    if ((manifest[key] ?? []).length) gaps.push(`${key} is set, but STORE.md and the policy promise none`);
  }
  return gaps;
}
