// Skip Husky's git-hook setup in production and CI - husky itself is a devDependency, so it
// isn't even installed there (that's exactly what broke Render's build: plain `npm install`
// still runs this "prepare" script, but with NODE_ENV=production devDependencies are skipped,
// so the `husky` binary doesn't exist and the old `"prepare": "husky"` script failed the whole
// install with "husky: not found"). Git hooks are a local-dev-only concern anyway - nothing
// running in CI/production ever needs them. This is Husky's own documented pattern for this
// exact problem: https://typicode.github.io/husky/how-to.html
if (process.env.NODE_ENV === "production" || process.env.CI === "true") {
  process.exit(0);
}

const husky = (await import("husky")).default;
console.log(husky());
