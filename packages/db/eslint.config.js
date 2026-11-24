import root from "../../eslint.config.js";

// @gym/db is the one package allowed to import drizzle-orm directly.
export default [...root, { rules: { "no-restricted-imports": "off" } }];
