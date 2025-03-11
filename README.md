# Robotability Project Website

This is the official website for the Robotability academic project from Cornell Tech. Built with [Astro](https://astro.build/), the site showcases our research on the Robotability Score, a novel metric for quantifying urban robot navigation suitability.

## About Robotability

The Robotability Score (R) is a novel metric that quantifies how suitable urban environments are for autonomous robot navigation. Through expert interviews and surveys, we've developed a standardized framework for evaluating urban landscapes to reduce uncertainty in robot deployment while respecting established mobility patterns.

This project was presented at CHI '25: ACM Conference on Human Factors in Computing Systems.

## Development

### Commands

All commands are run from the root of the project, from a terminal:

| Command               | Action                                             |
| :-------------------- | :------------------------------------------------- |
| `pnpm install`        | Installs dependencies                              |
| `pnpm dev`            | Starts local dev server at `localhost:4321`        |
| `pnpm build`          | Build your production site to `./dist/`            |
| `pnpm preview`        | Preview your build locally, before deploying       |
| `pnpm astro ...`      | Run CLI commands like `astro add`, `astro preview` |
| `pnpm astro --help`   | Get help using the Astro CLI                       |

## Technical Overview

### Built with Astro

This website is built using Astro, a modern static site generator that delivers excellent performance by shipping minimal JavaScript.

### UnoCSS

The site uses [UnoCSS](https://uno.antfu.me/) for styling, a utility-first CSS framework that's compatible with TailwindCSS syntax.

### Components

The website features several custom components:
- Interactive map of Robotability Scores across NYC
- Collapsible indicator list display
- Team member display cards
- YouTube video integration with LazyBoxVideo

## Project Structure

- `/src/pages/` - Page templates including the main index and map view
- `/src/components/` - UI components organized by function
- `/src/layouts/` - Layout templates for consistent page structure
- `/public/` - Static assets like team member images and logos

## Resources

- [Paper Link](https://doi.org/10.1145/3706598.3714009)
- [Code Repository](https://github.com/FAR-LAB/robotability-nyc)

## Team

- Matt Franchi - Computer Science PhD Candidate
- Maria Teresa Parreira - Information Science PhD Candidate
- Frank Bu - Computer Science PhD Candidate
- Wendy Ju - Associate Professor