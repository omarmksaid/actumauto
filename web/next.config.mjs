/** @type {import('next').NextConfig} */
export default {
  // `npm run build:check` sets NEXT_DIST_DIR so a production build can be verified WITHOUT
  // clobbering the dev server's .next. When they share a directory the dev server keeps serving
  // paths that no longer exist — CSS and JS 404, and the page renders unstyled, which looks like
  // a code bug rather than a stale cache.
  distDir: process.env.NEXT_DIST_DIR || ".next",
};
