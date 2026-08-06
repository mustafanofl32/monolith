/** Prints the resolved scroll model. `node pipeline/model.mjs [viewportHeight]` */
import { buildModel, describe } from '../src/scroll-model.js';
console.log(describe(buildModel(Number(process.argv[2]) || 900)));
