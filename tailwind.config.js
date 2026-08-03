/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      boxShadow: {
        soft: "0 1px 2px rgba(17, 24, 39, 0.06)",
      },
      colors: {
        ink: "#17202a",
        mash: "#f6f3ec",
        copper: "#b7672e",
        bottle: "#17694a",
      },
    },
  },
  plugins: [],
};
