const path = require("path");

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "export",
  images: {
    unoptimized: true,
  },
  // Pin Turbopack's root to this project folder. Without it, Next detects
  // multiple lockfiles (there's a stray package-lock.json in the home dir) and
  // guesses the wrong root. This project has its own package-lock.json here.
  turbopack: {
    root: __dirname,
  },
};

module.exports = nextConfig;