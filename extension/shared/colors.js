export const COLORS = {
  lemon: { id: "lemon", name: "Key idea", purpose: "Worth remembering", fill: "#E8CF62", ink: "#5C4A10" },
  moss: { id: "moss", name: "Action", purpose: "Something to try or follow up", fill: "#8FC38F", ink: "#1F3D28" },
  sky: { id: "sky", name: "Question", purpose: "Unclear or needs context", fill: "#87BFDF", ink: "#1A3A52" },
  rose: { id: "rose", name: "Concern", purpose: "A risk, disagreement, or warning", fill: "#DF9EAE", ink: "#5C2436" },
  iris: { id: "iris", name: "Insight", purpose: "A connection or new thought", fill: "#AF9ADA", ink: "#3A2A5C" },
  sand: { id: "sand", name: "Evidence", purpose: "A quote, fact, or source", fill: "#D2AE76", ink: "#4A3518" }
};

export const COLOR_IDS = Object.keys(COLORS);

export function colorOf(id) {
  return COLORS[id] || COLORS.lemon;
}
