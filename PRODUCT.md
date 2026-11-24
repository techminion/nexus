# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

- **Primary: the author, at home.** One person running their own desk, music, smart home, homelab and camera studio
  from one place. Their setup decides what Nexus does.
- **Secondary: other self-hosters** who install it from the public repository with `install.sh`. They are welcome,
  but they do not drive the design. Every integration is optional, so a fresh install with nothing configured must
  still look complete and not broken.

## Product Purpose

Nexus is one control and status surface for a home: clock and timers, a Spotify remote, Home Assistant and Alexa
(room sensors, weather and forecast, announcements, voice shortcuts), homelab and VPS health, a camera Studio (live
previews, OBS), and a Mac companion. It succeeds when a glance answers "what time is it, what's playing, is
everything OK", and the common actions take one tap.

## Positioning

It is self-hosted on a Raspberry Pi on the home network and joins things that never share a screen: Spotify, Alexa
through Home Assistant, the author's servers and VPS, OBS, and a Mac. Shortcuts chain actions across all of them, and
"Alexa, <shortcut name>" runs one by voice.

## Operating Context

- **The main screen** is a landscape Android tablet on the desk, running Fully Kiosk Browser. It is always on, read
  from a seat away, and tapped briefly.
- **Phones and laptop browsers** use it often too, so every page must work at phone width, on a tablet in landscape,
  and on a desktop browser.
- It is reached over HTTPS on the home network (Caddy, with a local certificate authority) and behind one password.
  Sessions last a year.
- It is updated by redeploying to the Pi. Open screens reload themselves when the new version is up.

## Capabilities and Constraints

- **Pages:** Dashboard, Music, Devices (Mac), Timer, Homelab, Studio, Settings.
- **Status strip:** Server, Spotify, Home and Homelab dots across the top.
- **Shortcuts:** up to five, each one action or a chain of steps.
- **Alerts:** phone alerts through ntfy when a problem lasts about 4 minutes, and again when it clears.
- **Integrations are optional.** An integration that isn't set up hides its card or says "not set up". It never
  shows an error.
- **Stack:** React, Vite and Tailwind for the web app; a Fastify server with SQLite; deployed as Podman containers on
  the Pi.

## Brand Commitments

- The name is **Nexus**.
- **Large touch targets** (48px or more) on every control, for use from a distance and in passing.
- **The light and dark themes must both keep working.**
- **No cloud or tracking:** no external fonts, analytics, CDNs or third-party requests from the page. Everything is
  served from the Pi.

## Evidence on Hand

- `README.md` and `installation_guide.md` describe the features and the setup.
- `docs/architecture.html` and `docs/architecture.png` show how it fits together.
- There are no users, testimonials or metrics beyond the author's own use. Do not invent any.

## Product Principles

1. **A glance first, a tap second.** The dashboard answers the common questions without interaction. Actions are
   one tap.
2. **Quiet when healthy, clear when not.** Problems show plainly in the status strip and in alerts. A normal day
   stays calm.
3. **Optional everything.** Each integration stands alone. Missing ones disappear cleanly.
4. **Local and private.** Nothing leaves the house unless the user configured it to (Spotify, ntfy, the VPS).

## Accessibility & Inclusion

- Read at a distance on the kiosk tablet, so text and the important figures must be large and high-contrast in
  both themes.
- Every control is usable by touch with large targets. Keyboard focus stays visible for laptop use.
