# Homepage map geometry

`world-map.json` contains locally rendered Natural Earth country boundaries.
It is generated with D3's Natural Earth projection; outlines are not hand-drawn.
Antarctica is omitted from the browsing map. Small territories and the European
Union can be represented with the repository's existing regional label points.
The map shows catalogue locations, not provider addresses or certified service coverage.

Sources:

- Natural Earth 4.1.0, redistributed as [world-atlas 2.0.2](https://github.com/topojson/world-atlas) (ISC license; Natural Earth data is public domain).
- [D3 7.9.0](https://github.com/d3/d3) and [topojson-client 3.1.0](https://github.com/topojson/topojson-client), used only to generate the local asset.

Download these files into `.tmp/map-build` at the repository root:

- https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/countries-110m.json (save as `world.json`)
- https://cdn.jsdelivr.net/npm/d3@7.9.0/dist/d3.min.js
- https://cdn.jsdelivr.net/npm/topojson-client@3.1.0/dist/topojson-client.min.js

Then run `node frontend/scripts/build-world-map.mjs .tmp/map-build`.
The browser needs no third-party map service or runtime geometry download.
