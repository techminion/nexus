# NEXUS
## Product Requirements Document (PRD)

**Version:** 1.0 — Initial specification  
**Status:** Planning  
**Date:** 18 November 2026  
**Product Type:** Personal, local-first desktop control system  
**Primary User:** Single user  
**Deployment:** Self-hosted Raspberry Pi 4B

---

## 1. Product Overview

### 1.1 Vision

Nexus is a modular, touchscreen-based command center that unifies music playback, connected devices, computer controls, smart-home automation, and personal productivity into one interface.

It is designed to sit above a keyboard, providing instant access to frequently used functionality without interrupting work on the primary computer.

**Product philosophy:** Everything connects. Everything stays within reach.

### 1.2 The Problem

Controlling everyday digital systems requires switching between multiple applications and devices:

- Spotify for music playback and speaker selection.
- Alexa for smart devices and routines.
- macOS for system actions.
- Grafana and other dashboards for homelab monitoring.
- OBS and camera utilities for content creation.
- Separate tools for timers, shortcuts, and reminders.

These interactions interrupt the primary workflow.

### 1.3 Proposed Solution

A single persistent, customizable interface powered by the Raspberry Pi and accessible from any device on the trusted local network.

Nexus will support touch interaction first, followed by physical buttons, rotary controls, and voice-triggered automations.

---

## 2. Product Goals

### Primary Goals

1. Create a responsive touchscreen dashboard optimized for landscape displays.
2. Control Spotify playback on connected devices, including the Echo Dot.
3. Provide configurable shortcuts and commonly used actions.
4. Support modular integrations without tightly coupling them to the main application.
5. Operate locally wherever possible, without requiring a cloud-hosted Nexus backend.
6. Allow the same software to transition from a Redmi phone to a dedicated Waveshare display.

### Non-Goals

Nexus is not intended to be:

- A replacement for macOS or a complete desktop environment.
- A commercial SaaS application.
- A multi-user platform.
- A general-purpose voice assistant.
- A media-streaming or transcoding server.
- A public internet-facing application.

---

## 3. Hardware Architecture

### Initial Hardware — v0.1

| Component | Purpose |
|---|---|
| Raspberry Pi 4B, 4GB | Nexus server |
| Redmi Note 10 Pro | Touchscreen client |
| Wi-Fi / Ethernet | Local connectivity |
| Amazon Echo Dot 5th Gen | Spotify audio output |

The Redmi operates as a browser client. No direct USB, HDMI, or GPIO connection between the phone and Raspberry Pi is required.

### Final Hardware — v1.0

| Component | Purpose |
|---|---|
| Raspberry Pi 4B | Main processor |
| Waveshare 12.3-inch touchscreen | Dedicated interface |
| ESP32 | Hardware input/output controller |
| Rotary encoder | Volume and navigation |
| Programmable buttons | Physical shortcuts |
| LED strip | Ambient illumination and status |
| Custom enclosure | Desktop wedge-style housing |

**Display target:** 1920 × 720, landscape orientation.

The enclosure should support removable electronics, passive ventilation, protected low-voltage wiring, and future hardware expansion.

---

## 4. Functional Requirements

### 4.1 Dashboard — P0

**Description:** The primary interface used throughout the day.

Requirements:

- Responsive landscape-oriented layout.
- Dark theme by default.
- Persistent navigation between dashboard sections.
- Large, touch-friendly interactive elements.
- Clock and date display.
- Spotify Now Playing widget.
- Quick-action controls.
- Connection indicators for supported integrations.
- Basic settings screen.
- Graceful handling of disconnected services.

The initial release uses a curated layout. Advanced drag-and-drop customization is deferred.

### 4.2 Spotify Controller — P0

**Description:** A dedicated remote controller for Spotify playback.

Requirements:

- Secure Spotify account authorization.
- Display current track, artist, and album artwork.
- Show playback progress and duration.
- Play, pause, next, and previous controls.
- Playback volume adjustment.
- Shuffle and repeat controls where permitted.
- Display available Spotify Connect devices.
- Transfer playback to a supported available device.
- Display clear connection and playback errors.
- Handle expired access tokens automatically.
- Recover gracefully from API rate limits.

**Extended features — P1:**

- Favorite playlist shortcuts.
- Playlist browsing.
- Recently played media where available.
- Queue display and management where supported.
- Expanded full-screen Now Playing view.

**Important:** Nexus controls Spotify rather than streaming or redistributing Spotify audio itself.

### 4.3 Clock and Utilities — P0

Requirements:

- Local date and time.
- 12-hour and 24-hour display options.
- Timer and stopwatch.
- Configurable display brightness preferences where the client hardware permits.
- Optional fullscreen clock mode.

**P1:** Weather and upcoming calendar events.

### 4.4 Quick Actions — P0

Provide five configurable shortcut buttons in the initial release.

Supported initial actions:

- Open an assigned URL.
- Navigate to a Nexus module.
- Select a saved Spotify destination.
- Launch a configured Nexus scene made up of supported actions.

Future actions may include Mac commands, Home Assistant services, and ESP32 outputs.

Shortcuts must never execute arbitrary user-provided shell commands on the server.

### 4.5 Dashboard Modes — P1

Support configurable interface presets.

| Mode | Primary Content |
|---|---|
| Desk | Spotify, clock, shortcuts |
| Focus | Timer, minimal music, productivity |
| Studio | Camera controls, recording status |
| Homelab | System metrics, service health |
| Ambient | Clock, artwork, photographs |

Each mode may define its own layout, preferred widgets, and supported actions.

The active mode should survive browser reloads.

### 4.6 Alexa / Echo Integration — P1

Use the existing Amazon Echo Dot 5th Gen.

Requirements:

- Echo Dot selection as a Spotify Connect destination.
- Supported speaker controls.
- Home Assistant integration for available Alexa features.
- Configurable announcement actions.
- Access to supported sensor information.
- Optional routines and voice-triggered scenes.

Sensor availability and behavior must be verified for the configured Echo device and integration.

Nexus will not attempt to run Alexa's wake-word recognition itself.

### 4.7 Homelab Monitoring — P1

Show selected infrastructure metrics without replicating full Grafana functionality.

Requirements:

- Raspberry Pi CPU, RAM, storage and temperature.
- Uptime and service health.
- Configured Podman container status.
- Status of selected remote Linux hosts.
- Shortcuts to Grafana, Netdata and other tools.

System-control actions must require explicit configuration and appropriate authorization.

### 4.8 ESP32 Hardware Controller — P2

Communicate with an ESP32 using 3.3V UART initially.

Requirements:

- Rotary encoder event handling.
- Programmable physical buttons.
- Device connection and health state.
- LED brightness and color commands.
- Configurable input-to-action mappings.
- Recover from ESP32 disconnects without restarting Nexus.
- Define a versioned serial message protocol.

Potential future expansions include sensors, NFC, external modules and wireless MQTT-based nodes.

### 4.9 Mac Companion — P2

A lightweight companion process running on macOS.

Possible capabilities:

- Media controls.
- Launch approved applications or Shortcuts.
- Lock the Mac.
- Adjust supported system settings.
- Trigger approved OBS actions.
- Report connectivity and basic system status.

All actions must be explicitly allowlisted and authenticated.

### 4.10 Camera Hub — P2

Enable Nexus to preview and control camera feeds hosted elsewhere on the local network.

Requirements:

- Register configured camera streams.
- Display browser-compatible live previews.
- Show stream availability.
- Open full-screen camera views.
- Trigger approved recording or scene-switch actions through a compatible controller.

Media processing should run on a separate capable host when required, rather than overloading the Raspberry Pi.

---

## 5. User Experience Requirements

### 5.1 Main Layout

The initial dashboard will contain:

**Header:** Nexus identity, clock, connection status.

**Primary area:** Large Spotify widget with artwork and playback controls.

**Secondary area:** Quick actions and small utility widgets.

**Navigation:** Compact persistent menu for Dashboard, Music, Devices, Modes and Settings.

### 5.2 Design Language

- Minimalist, dark-first interface.
- Neutral charcoal and near-black surfaces.
- One restrained accent color.
- Clear typography and high contrast.
- Rounded components without excessive decoration.
- Subtle animations with reduced-motion support.
- Touch targets of at least approximately 44 × 44 CSS pixels.
- No hover-dependent essential actions.

### 5.3 Display Responsiveness

The UI must support:

- Redmi Note 10 Pro in landscape orientation.
- Modern desktop browsers.
- Waveshare 1920 × 720 display.
- Other similarly sized displays where practical.

Layout decisions should be based on viewport dimensions rather than device-specific hardcoding.

### 5.4 Ambient Behavior

When idle, Nexus may transition to a simplified clock or ambient interface.

For the Redmi, the design must respect AMOLED screen longevity and battery health. A continuously illuminated screen is not required.

---

## 6. Technical Architecture

### 6.1 Recommended Stack

| Layer | Technology |
|---|---|
| Frontend | React, TypeScript, Vite |
| Styling | Tailwind CSS, shadcn/ui |
| Frontend state | Zustand |
| Data fetching | TanStack Query |
| Backend | Node.js, Fastify |
| Database | SQLite, Drizzle ORM |
| Real-time updates | WebSockets |
| API | REST |
| Container runtime | Podman |
| Service management | systemd Quadlet |
| Reverse proxy | Caddy |
| Remote connectivity | Tailscale |
| ESP32 firmware | ESP-IDF |
| Automation integration | Home Assistant |
| Camera distribution | MediaMTX |
| Repository | pnpm workspace |

### 6.2 Core Modules

**Nexus UI:** Browser interface and touchscreen interactions.

**Nexus API:** Authentication, settings and integration endpoints.

**Nexus Events:** Real-time updates and command acknowledgments.

**Nexus Actions:** Authorized actions, shortcuts and scene execution.

**Nexus Integrations:** Independent adapters for Spotify, Home Assistant, devices and external services.

**Nexus Hardware:** Serial protocol handling and ESP32 communication.

### 6.3 Data Storage

SQLite will store:

- Dashboard configurations.
- Widget settings.
- User preferences.
- Shortcut definitions.
- Scene configurations.
- Integration metadata.
- Limited diagnostic event history.

Sensitive integration credentials must be stored securely and excluded from API responses, browser storage, source control and logs.

### 6.4 Deployment

Nexus Core runs on the Raspberry Pi as a managed service.

The frontend is served locally through a reverse proxy with appropriate HTTPS configuration.

A public cloud dependency is not required for hosting Nexus.

---

## 7. Integration and Security Requirements

- Single-user architecture.
- Authenticated access to privileged Nexus functions.
- HTTPS for protected remote/browser access.
- Secure OAuth authorization and token refresh.
- Least-privilege integration permissions.
- No hardcoded API secrets.
- Network access restricted to trusted clients.
- Tailscale supported for remote access.
- Explicit allowlists for device and OS commands.
- Configurable logging without exposing credentials.
- Automatic recovery from temporary network failures.

For Spotify, use a supported OAuth authorization code flow, with PKCE where appropriate, and a registered compliant redirect URI.

Internet-dependent integrations must display an unavailable state if their services cannot be reached.

---

## 8. Non-Functional Requirements

| Category | Target |
|---|---|
| UI startup | Interactive within 3 seconds on a healthy local network, after assets are available |
| Touch feedback | Visible feedback within 200 ms |
| Remote actions | Immediate acknowledgment; completion or error displayed separately |
| Reliability | Automatic restart after process failure |
| Recovery | Resume after Raspberry Pi reboot |
| Resource usage | Designed for Raspberry Pi 4B with 4GB RAM |
| Modularity | Integration failures must not crash the dashboard |
| Persistence | Preferences survive reboot and service updates |
| Security | Privileged endpoints never exposed without access controls |
| Accessibility | Readable text, contrast and touch-friendly interaction |

Performance targets are goals to validate against actual hardware, not guaranteed service response times.

---

## 9. Release Roadmap

| Release | Scope |
|---|---|
| **v0.1 — Foundation** | Dashboard, Spotify, clock, five shortcuts, settings |
| **v0.2 — Connected** | Alexa bridge, scenes, basic homelab monitoring |
| **v0.3 — Physical** | ESP32, rotary encoder, buttons, LEDs |
| **v0.4 — Studio** | Mac companion, cameras, OBS integration |
| **v1.0 — Dedicated Console** | Waveshare display, enclosure, kiosk mode, hardware integration |

There are no fixed delivery dates. Features will be delivered incrementally.

---

## 10. MVP Acceptance Criteria

Nexus v0.1 is complete when:

- [ ] Dashboard loads successfully on Redmi in landscape mode.
- [ ] Raspberry Pi hosts the frontend and backend.
- [ ] Spotify account can be authorized securely.
- [ ] Current track and album artwork are displayed.
- [ ] Playback controls operate on a supported active device.
- [ ] Available Spotify Connect devices can be listed.
- [ ] Playback can be transferred when supported by the API and device.
- [ ] Clock displays accurate local time.
- [ ] Five user-configurable shortcuts work.
- [ ] Settings remain saved after restarting Nexus.
- [ ] UI responds correctly to touch and browser resizing.
- [ ] Disconnected services display understandable errors.
- [ ] Nexus automatically starts following a Raspberry Pi reboot.
- [ ] The system can run without a monitor connected directly to the Pi.

A failing third-party integration should not prevent access to local widgets.

---

## 11. Risks and Dependencies

| Risk | Mitigation |
|---|---|
| Spotify API restrictions | Verify endpoints, account eligibility and permissions before integration |
| API rate limits | Cache responses, use adaptive polling and backoff |
| Alexa integration limitations | Use supported Home Assistant functionality and fallbacks |
| Raspberry Pi resource constraints | Offload camera processing to another host |
| Redmi AMOLED burn-in | Sleep/ambient modes and reduced static UI |
| Different display ratios | Responsive layout with viewport-based breakpoints |
| GPIO electrical faults | Use 3.3V logic, suitable power supplies and protected connections |
| Network interruptions | Reconnection, retries and clear status indicators |

---

## 12. Definition of Success

Nexus should become useful enough to remain on the desk every day.

Success means:

- Common music operations can be performed without opening Spotify on the main computer.
- Frequently used shortcuts are accessible with one touch.
- The interface remains responsive during normal use.
- New integrations can be added without redesigning the core.
- The same dashboard works on the Redmi and the future dedicated display.
- Nexus stays understandable, maintainable and enjoyable as a personal project.

**Final product principle:**

Nexus should make the desk simpler, not create another system that constantly demands attention.