export const COLORS = {
  lemon: { id: "lemon", name: "Lemon", fill: "#F6E27A", ink: "#5C4A10" },
  moss: { id: "moss", name: "Moss", fill: "#A8D5A2", ink: "#1F3D28" },
  sky: { id: "sky", name: "Sky", fill: "#A8D4F0", ink: "#1A3A52" },
  rose: { id: "rose", name: "Rose", fill: "#F3B6C4", ink: "#5C2436" },
  iris: { id: "iris", name: "Iris", fill: "#C9B7F2", ink: "#3A2A5C" },
  sand: { id: "sand", name: "Sand", fill: "#E7C899", ink: "#4A3518" }
};

export const COLOR_IDS = Object.keys(COLORS);

export function colorOf(id) {
  return COLORS[id] || COLORS.lemon;
}
