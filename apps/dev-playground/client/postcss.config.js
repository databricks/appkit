import path from "node:path";

const __dirname = path.dirname(new URL(import.meta.url).pathname);

export default {
  plugins: {
    tailwindcss: { config: path.resolve(__dirname, "./tailwind.config.ts") },
    autoprefixer: {},
  },
};
