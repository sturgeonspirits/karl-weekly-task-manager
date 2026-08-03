/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      boxShadow: {
        soft: "0 1px 2px rgba(17, 24, 39, 0.06)",
      },
      colors: {
        ink: "#242622",
        mash: "#F1F1E7",
        copper: "#96321F",
        bottle: "#87A67F",
        brown: "#7E613F",
        tan: "#C8BCA4",
      },
    },
  },
  plugins: [],
};
