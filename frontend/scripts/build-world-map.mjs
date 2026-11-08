// Regenerate with: node frontend/scripts/build-world-map.mjs .tmp/map-build
// Input versions and licenses are documented in lib/data/WORLD-MAP.md.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const input = path.resolve(process.argv[2] || ".tmp/map-build");
const runtime = vm.createContext({});
for (const filename of ["d3.min.js", "topojson-client.min.js"]) {
  vm.runInContext(fs.readFileSync(path.join(input, filename), "utf8"), runtime);
}
const { d3, topojson } = runtime;
const topology = JSON.parse(fs.readFileSync(path.join(input, "world.json"), "utf8"));
const features = topojson.feature(topology, topology.objects.countries).features.filter((f) => f.properties.name !== "Antarctica");
const projection = d3.geoNaturalEarth1().fitExtent([[16, 18], [944, 482]], { type: "FeatureCollection", features });
const geoPath = d3.geoPath(projection).digits(2);
const aliases = { "United States of America": "United States", Czechia: "Czech Republic" };
const coverage = fs.readFileSync(new URL("../lib/coverage.ts", import.meta.url), "utf8");
const labelPoints = new Map([...coverage.matchAll(/name: "([^"]+)", latitude: ([-\d.]+), longitude: ([-\d.]+)/g)].map((m) => [m[1], [+m[3], +m[2]]]));
const countries = features.map((feature) => {
  const name = aliases[feature.properties.name] || feature.properties.name;
  return { name, path: geoPath(feature), point: projection(labelPoints.get(name) || d3.geoCentroid(feature)).map((v) => +v.toFixed(2)) };
});
for (const [name, coords] of labelPoints) {
  if (!countries.some((c) => c.name === name)) countries.push({ name, path: "", point: projection(coords).map((v) => +v.toFixed(2)) });
}
const output = new URL("../lib/data/world-map.json", import.meta.url);
fs.mkdirSync(path.dirname(fileURLToPath(output)), { recursive: true });
fs.writeFileSync(output, JSON.stringify({ width: 960, height: 500, countries }) + "\n");
console.log(`Generated ${countries.length} country/region shapes and label points.`);
