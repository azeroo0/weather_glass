# Weather Glass

A generative weather visualization site that turns live weather data into flowing particle art — scroll through real cities, each with its own physical behavior.

**Live:** https://weatherglass-two.vercel.app

## Overview

Weather Glass reimagines a weather forecast as an ambient, cinematic experience. Instead of icons and numbers, air is rendered as a flow-field particle system whose motion, color, and density are driven directly by real conditions — temperature, wind speed, wind direction, precipitation, and cloud cover — pulled live from the Open-Meteo API.

Each city becomes a pinned scroll chapter. As you scroll, the background doesn't fade between states — it physically transforms, blending particle speed, direction, shape, and color from one city's weather into the next.

## Features

- **Live weather data** — real-time temperature, wind, precipitation, and cloud cover via the Open-Meteo API, no API key required
- **Scroll-driven chapters** — each city is a full-screen pinned section; scrolling scrubs the transition between weather states
- **Distinct weather physics** — sunny, cloudy, rain, thunderstorm, and snow each have their own particle shape, motion, and color palette, not just a color swap
- **Day/night cycle** — a time-of-day slider blends background brightness and particle behavior from dawn to midnight, with an autoplay option to watch a full day pass
- **City search** — add any city via geocoding search, up to 8 at once
- **Interactive background** — a cursor-reactive distortion field and click ripples respond to the visitor in real time
- **Performance-tuned rendering** — batched canvas draws, a precomputed noise grid, capped device pixel ratio, and reduced particle counts on mobile keep frame rates smooth
- **Accessible by default** — full keyboard control, ARIA labeling, and a static fallback for `prefers-reduced-motion`

## Tech stack

- TypeScript + Vite
- GSAP + ScrollTrigger
- HTML5 Canvas 2D
- Open-Meteo API (weather + geocoding)
- Deployed on Vercel

## Getting started

```bash
npm install
npm run dev
```

Build for production:

```bash
npm run build
```
