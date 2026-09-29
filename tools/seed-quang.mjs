import { seedDemo } from "./seed-demo.js";
const res = await seedDemo({
  force: true,
  doctorId: "40e6d0a1-5099-4157-8d5b-873976f17e20",   // quang@retinax.ai
});
console.log(res);
