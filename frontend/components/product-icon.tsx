import type { SVGProps } from "react";

const paths = {
  home: "m3 11 9-8 9 8v9H6v-9m4 9v-6h4v6",
  grid: "M4 4h6v6H4ZM14 4h6v6h-6ZM4 14h6v6H4ZM14 14h6v6h-6Z",
  search: "M16.5 16.5 21 21M18 10.5a7.5 7.5 0 1 1-15 0 7.5 7.5 0 0 1 15 0",
  document: "M14 3H5v18h14V8zM14 3v5h5M8 13h8M8 17h6",
  upload: "M12 16V4m-5 5 5-5 5 5M4 16v5h16v-5",
  workflow: "M12 8v5M5 17v-4h14v4M15 5a3 3 0 1 1-6 0 3 3 0 0 1 6 0M8 20a3 3 0 1 1-6 0 3 3 0 0 1 6 0M22 20a3 3 0 1 1-6 0 3 3 0 0 1 6 0",
  check: "m8 12 3 3 5-6M12 3l8 3v6c0 5-8 9-8 9s-8-4-8-9V6Z",
  compare: "M9 3h6M10 3v5l-5 9a2 2 0 0 0 2 3h10a2 2 0 0 0 2-3l-5-9V3M8 14h8",
  review: "M12 3v4M5 7h14v13H5zM9 12h6M9 16h4",
  book: "M4 5a4 4 0 0 1 4-1l4 2v15l-4-2a4 4 0 0 0-4 1zm16 0a4 4 0 0 0-4-1l-4 2v15l4-2a4 4 0 0 1 4 1z",
  arrow: "M4 12h16m-6-6 6 6-6 6",
  "arrow-left": "M20 12H4m6-6-6 6 6 6",
  "first-page": "M3 5v14M21 12H7m6-6-6 6 6 6",
  "last-page": "M21 5v14M3 12h14m-6-6 6 6-6 6",
  "back-to-top": "m5 14 7-7 7 7M12 7v14M5 3h14",
  chevron: "m9 5 7 7-7 7",
  menu: "M4 6h16M4 12h16M4 18h16",
  close: "m6 6 12 12M6 18 18 6",
  user: "M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0M4 21v-2a8 8 0 0 1 16 0v2",
  inbox: "M3 13 6 5h12l3 8v6H3zm0 0h5l2 3h4l2-3h5",
  logout: "M11 4H4v16h7M9 12h12m-4-4 4 4-4 4",
  diagram: "M3 3h6v6H3ZM15 15h6v6h-6ZM6 9v9h9M9 6h9v9",
  audio: "M9 5a3 3 0 0 1 6 0v7a3 3 0 0 1-6 0zM5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8",
} as const;

export type ProductIconName = keyof typeof paths;

/** The same compact icon vocabulary is used in navigation and homepage artwork. */
export default function ProductIcon({ name, ...props }: SVGProps<SVGSVGElement> & { name: ProductIconName }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}><path d={paths[name]} /></svg>;
}
