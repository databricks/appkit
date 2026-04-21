import path from "node:path";
import type { Config } from "tailwindcss";

export default {
  darkMode: ["class", "media"],
  content: [
    path.resolve(__dirname, "./index.html"),
    path.resolve(__dirname, "./src/**/*.{js,ts,jsx,tsx}"),
  ],
  plugins: [require("tailwindcss-animate")],
} satisfies Config;
