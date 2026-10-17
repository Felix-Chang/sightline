// Lets side-effect CSS imports (e.g. `import "./globals.css"`) type-check under
// TypeScript's noUncheckedSideEffectImports, which is on by default in TS 6.
declare module "*.css";
