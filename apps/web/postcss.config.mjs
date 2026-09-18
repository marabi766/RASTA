/**
 * Tailwind v4 is a PostCSS plugin and needs no configuration file of its own:
 * the theme lives in `@theme` inside `globals.css`, which is where docs/16
 * § 16.4 expects the tokens to be defined.
 */
export default {
  plugins: { '@tailwindcss/postcss': {} },
};
