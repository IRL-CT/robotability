---
title: Robotability 2.0
description: The Robotability site relaunches with live scoring, a snapshot archive with a time scrubber, and a new design.
pubDate: "2026-08-12"
author: Matt Franchi
tags:
  - updates
  - data
imgUrl: '../../assets/astro.jpeg'
---

The Robotability site relaunches today. This post describes what changed, how
live scoring works, and which data stay pinned.

## What changed

Three things changed in this release.

**Live scoring.** The map can recompute the Robotability score on demand for
the features that come from NYC OpenData. You press a button, and the map
refreshes the scores for the area you view.

**Snapshot archive with a time scrubber.** The site publishes dated snapshots
of the full map. A time scrubber moves across them. You can compare two dates
and play the sequence.

**New design.** The site uses a new design.

## How live scoring works

Live scoring runs in your browser. When you press the refresh button, the
browser queries NYC OpenData through the Socrata SODA API. It requests the
sidewalk segments inside the current viewport. The viewport must be small. The
map caps the refresh area at 8 square kilometers. On a larger view it asks you
to zoom in.

The client then recomputes each score. It uses the min-max feature statistics
of the current snapshot and the weights from the survey. A quota guard caps
requests at 40 per rolling hour. The guard backs off after a rate limit.

Live values approximate the pipeline. The pipeline samples 50-foot buffers
around each segment. The browser queries segment midpoints and endpoints
instead. The UI labels live values as approximate.

## What stays pinned and why

Live scoring does not cover every feature. Some features stay pinned at the
latest snapshot values during a live refresh.

The pinned features are:

- Pedestrian, bicycle, and vehicle density. These come from the lab dashcam
  detections.
- Surveillance coverage.
- The three constant features: sidewalk roughness, GPS signal strength, and
  digital map existence.
- FCC broadband coverage.
- Elevation slope.

The lab cluster computes these features on a schedule from lab storage. They
ship in each snapshot. A browser can not recompute them, so live refresh holds
them at the latest snapshot values.

## Dataset attribution

The proxy datasets come from NYC OpenData. We credit NYC OpenData as the
source of this data.

"The City of New York can not vouch for the accuracy or completeness of data provided by this web site or application or for the usefulness or integrity of the web site or application. This site provides applications using data that has been modified for use from its original source, NYC.gov, the official web site of the City of New York."
