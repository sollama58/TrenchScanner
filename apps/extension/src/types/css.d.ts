/** Stylesheets bundled as text (build.mjs's loader), for the content script's shadow roots. */
declare module "*.css" {
  const text: string;
  export default text;
}
