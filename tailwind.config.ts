import type { Config } from "tailwindcss";
import tailwindcssAnimate from "tailwindcss-animate";

const config: Config = {
  darkMode: ["class"],
  content: ["./src/**/*.{ts,tsx,mdx}"],
  theme: {
    container: {
      center: true,
      padding: "1.5rem",
      screens: { "2xl": "1500px" },
    },
    extend: {
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
        factory: {
          lime: "hsl(var(--factory-lime))",
          amber: "hsl(var(--factory-amber))",
          cyan: "hsl(var(--factory-cyan))",
          red: "hsl(var(--factory-red))",
          ink: "#080a09",
          panel: "#0e1210",
          line: "#202823",
        },
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      fontFamily: {
        sans: [
          "ui-sans-serif",
          "-apple-system",
          "BlinkMacSystemFont",
          "SF Pro Display",
          "Segoe UI",
          "sans-serif",
        ],
        mono: ["ui-monospace", "SFMono-Regular", "SF Mono", "Menlo", "monospace"],
      },
      keyframes: {
        "accordion-down": {
          from: { height: "0" },
          to: { height: "var(--radix-accordion-content-height)" },
        },
        "accordion-up": {
          from: { height: "var(--radix-accordion-content-height)" },
          to: { height: "0" },
        },
        "pulse-line": {
          "0%, 100%": { opacity: "0.35" },
          "50%": { opacity: "1" },
        },
        scan: {
          "0%": { transform: "translateY(-100%)" },
          "100%": { transform: "translateY(400%)" },
        },
        "fade-up": {
          from: { opacity: "0", transform: "translateY(6px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        blink: {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0" },
        },
        shimmer: {
          from: { backgroundPosition: "200% 0" },
          to: { backgroundPosition: "-200% 0" },
        },
        glow: {
          "0%, 100%": { boxShadow: "0 0 24px -6px rgba(200, 241, 105, 0.35)" },
          "50%": { boxShadow: "0 0 40px -4px rgba(200, 241, 105, 0.55)" },
        },
        "status-ping": {
          "0%": { boxShadow: "0 0 0 0 rgba(200, 241, 105, 0.45)" },
          "80%": { boxShadow: "0 0 0 8px rgba(200, 241, 105, 0)" },
          "100%": { boxShadow: "0 0 0 0 rgba(200, 241, 105, 0)" },
        },
        "live-ping": {
          "0%": { transform: "scale(1)", opacity: "0.7" },
          "80%, 100%": { transform: "scale(2.6)", opacity: "0" },
        },
      },
      animation: {
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
        "pulse-line": "pulse-line 2.4s ease-in-out infinite",
        scan: "scan 3s linear infinite",
        "fade-up": "fade-up 0.35s ease-out both",
        blink: "blink 1s step-end infinite",
        shimmer: "shimmer 1.6s linear infinite",
        glow: "glow 2s ease-out infinite",
        "status-ping": "status-ping 1.6s cubic-bezier(0, 0, 0.2, 1) infinite",
        "live-ping": "live-ping 2s cubic-bezier(0, 0, 0.2, 1) infinite",
      },
      backgroundImage: {
        "grid-factory":
          "linear-gradient(to right, rgba(255,255,255,0.035) 1px, transparent 1px), linear-gradient(to bottom, rgba(255,255,255,0.035) 1px, transparent 1px)",
        "radial-fade":
          "radial-gradient(circle at 50% 0%, rgba(200,241,105,0.09), transparent 55%)",
      },
      backgroundSize: {
        grid: "36px 36px",
      },
    },
  },
  plugins: [tailwindcssAnimate],
};

export default config;
