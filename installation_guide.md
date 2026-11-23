# Installing Nexus

This guide sets up your own Nexus: a wall or desk dashboard served by a Raspberry Pi and shown on any tablet or
phone browser. The core install takes about 15 minutes, most of it the first image build on the Pi. Everything after
that (Spotify, Alexa, cameras, Mac, VPS) is optional and can be added one at a time.

## What you need

- **A Raspberry Pi 4 or 5** (2 GB RAM or more), or any 64-bit machine running Debian or Ubuntu.
- **A 64-bit OS with Podman 4.4 or newer.** Raspberry Pi OS (64-bit) based on Debian 13 "Trixie", Debian 13, or
  Ubuntu 24.04 or newer. Debian 12 "Bookworm" ships Podman 4.3, which is too old: the installer checks this.
- **Your computer** (Linux or macOS) with `git`, `ssh` and `rsync`. You run the installer here; it sets up the Pi
  over ssh.
- **A screen to show Nexus on:** any tablet or phone with a browser. A cheap Android tablet with Fully Kiosk Browser
  works well as a wall display.
- Ports 80, 443 and 8443 free on the Pi.

## 1. Prepare the Pi

1. Flash the OS with [Raspberry Pi Imager](https://www.raspberrypi.com/software/). In its settings, set a hostname
   (e.g. `nexus`), create a user, and turn on SSH with your public key.
2. Boot the Pi on your network and give it a **fixed IP address**: add a DHCP reservation for it in your router.
   Nexus is reached by IP and by name, and its HTTPS certificate is issued for those.
3. Check you can log in without a password: `ssh <user>@<pi>`. If it asks for a password, run
   `ssh-copy-id <user>@<pi>` first.

The installer needs passwordless `sudo` for that user. The first user on Raspberry Pi OS has it already; on other
systems the installer tells you the one-line fix.

## 2. Run the installer

On your computer:

```sh
git clone https://github.com/techminion/nexus.git
cd nexus
./install.sh
```

It asks:

| Question | What to enter |
|---|---|
| ssh login of the Pi | `user@host`, e.g. `pi@nexus.local` |
| The Pi's LAN IPv4 address | Detected from the Pi; press Enter to accept |
| Names for the Pi | Every name that reaches the Pi on your network, e.g. `nexus nexus.lan`. These go into the certificate. |
| Studio PC's IP (optional) | Leave empty unless you will run the cameras (see Studio below) |
| Build DNS servers (optional) | Leave empty; only needed if the image build cannot resolve names |

Then it:

1. checks the Pi (64-bit, Podman version, sudo) and offers to install Podman, rsync and openssl if they are missing,
2. saves your answers in `deploy/site.env` (on your computer, not committed to git),
3. copies the code to `~/nexus` on the Pi, builds the image there and starts the services: Nexus, Caddy (HTTPS) and
   Home Assistant,
4. waits until Nexus answers, then prints the address.

Re-running `./install.sh` is safe. It offers to keep your saved settings and just redeploy.

## 3. Log in

Open `https://<pi-ip>/` (or one of the names you gave). Your browser will warn about the certificate the first time:
see the next step.

The login password was generated on the Pi. Read it with:

```sh
ssh <user>@<pi> sudo grep NEXUS_PASSWORD /etc/nexus/nexus.env
```

To change it, edit `NEXUS_PASSWORD` in `/etc/nexus/nexus.env` on the Pi and run `sudo systemctl restart nexus`.
Changing the password logs out every screen.

## 4. Trust the certificate

Caddy issues HTTPS certificates from its own local authority, because public authorities do not issue them for
LAN addresses. Browsers warn until each device trusts that authority's root certificate.

Copy it off the Pi:

```sh
ssh <user>@<pi> sudo podman cp nexus-caddy:/data/caddy/pki/authorities/local/root.crt - | tar -xO > nexus-root.crt
```

Then install `nexus-root.crt` as a trusted certificate authority:

- **macOS:** double-click it, add it to the System keychain, then in Keychain Access open it and set "Always Trust".
- **Windows:** double-click it, "Install Certificate", Local Machine, "Trusted Root Certification Authorities".
- **Linux:** `sudo cp nexus-root.crt /usr/local/share/ca-certificates/ && sudo update-ca-certificates`
  (Fedora/RHEL: `/etc/pki/ca-trust/source/anchors/` and `sudo update-ca-trust`). Firefox has its own store:
  Settings, Certificates, Import.
- **Android:** Settings, Security, Encryption & credentials, Install a certificate, CA certificate.
- **iOS:** AirDrop or mail it to the device, install the profile, then turn it on in Settings, General, About,
  Certificate Trust Settings.

Only trust this file from your own Pi: anyone holding Caddy's key could impersonate sites to devices that trust it.

## 5. Put it on a screen

Open the address on the tablet, log in once (sessions last a year) and add it to the home screen. On Android,
Fully Kiosk Browser can keep it full-screen and awake.

## Optional integrations

Each integration is switched on by adding variables to `/etc/nexus/nexus.env` on the Pi, then
`sudo systemctl restart nexus`. The full list is in [README.md](README.md#environment); the sections below are
the shortest path for each.

### Spotify (playback control, needs Premium)

1. Create an app at the [Spotify developer dashboard](https://developer.spotify.com/dashboard).
2. Add the redirect URI shown by `PUBLIC_URL` in `nexus.env` plus `/api/spotify/callback`, e.g.
   `https://nexus.lan/api/spotify/callback`.
3. Set `SPOTIFY_CLIENT_ID`, restart, then use Settings, Connect Spotify in Nexus.

`PUBLIC_URL` is set once, at the first install. If you later rename the Pi, update `PUBLIC_URL` in `nexus.env` and
the redirect URI in the Spotify app to match.

### Home Assistant and Alexa (room sensors, announcements, voice shortcuts)

Home Assistant already runs on the Pi, at `https://<pi-ip>:8443`. One-time setup:

1. Let Home Assistant accept requests through Caddy. Stop it with `sudo systemctl stop homeassistant`, then edit
   `.storage/http` in its config volume (`sudo podman volume inspect homeassistant-config --format '{{.Mountpoint}}'`
   gives the folder): under `data.stable`, set `"use_x_forwarded_for": true` and `"trusted_proxies"` to the
   subnet of the `nexus` container network: `["10.89.0.0/24"]` on a new install. On an installation that predates
   this guide, check it with `sudo podman network inspect nexus --format '{{range .Subnets}}{{.Subnet}}{{end}}'`.
   Start it again with `sudo systemctl start homeassistant`. Without this, every page returns error 400.
   If `.storage/http` does not exist yet, open the page once first so Home Assistant creates it.
2. Open `https://<pi-ip>:8443`, create your account, and add the **Alexa Devices** integration (it logs in to Amazon).
3. Create a long-lived token (your profile, Security) and set `HA_URL=http://homeassistant:8123` and `HA_TOKEN`.
4. Optionally: `HA_SENSORS` (entities to show, e.g. the Echo's temperature), `HA_ANNOUNCE_ENTITY` (announcements)
   and `HA_VOICE_ENTITY` (run a Nexus shortcut by saying "Alexa, <shortcut name>"). See the README for details.

### Studio (live camera previews and OBS)

Needs a Linux PC on the same network.

1. Re-run `./install.sh` and enter the PC's IP as the Studio PC, so Caddy forwards camera requests to it.
2. On the PC, clone this repository, copy your `deploy/site.env` into it, and run `deploy/studio/install.sh`.
   It installs MediaMTX as a user service and lists the webcams it found.
3. Set `STUDIO_API=http://<studio-ip>:9997` in `nexus.env` and restart Nexus.
4. Optional: `deploy/studio/obs-setup.sh` for OBS control, then set `OBS_URL` and `OBS_PASSWORD`.

Phones, RTMP apps and action cameras: README, "Studio: adding a camera".

### Mac (volume, media keys, apps)

See README, "Mac companion". In short: create a key on the Pi, then run `deploy/mac/install.sh '<key>' <pi-ip>` on
the Mac and set `MAC_HOST` and `MAC_USER`.

### Phone alerts

Install the [ntfy](https://ntfy.sh) app and subscribe to a topic with a long random name (on the public ntfy.sh
server, the name is the only thing keeping others out). Set `NTFY_URL=https://ntfy.sh/<that-topic>` (or your own
server's topic, with `NTFY_TOKEN` if it requires login), restart Nexus, then Settings, Send test alert. You get a
message when a host, container, the VPS or Home Assistant has a problem for about 4 minutes, and when it clears.

### Servers and a VPS (Homelab page)

- `NEXUS_HOSTS=nas=192.168.1.10:22,router=192.168.1.1:443` shows whether each host answers on that port.
  For a server with fail2ban, check a web port rather than ssh, so the checks are never counted as failed logins.
- For CPU, memory and containers of a Linux VPS: README, "VPS companion".

### Backups

Nightly, encrypted, to another Linux machine you can ssh to (a NAS, a desktop that stays on, a VPS): README,
"Backups". Three commands, one of them on the backup server. Keep a copy of the backup password off the Pi.

## Updating

```sh
git pull
deploy/deploy.sh
```

`deploy.sh` reads `deploy/site.env`, rebuilds the image on the Pi and restarts the services. Your settings,
shortcuts and logins live on the Pi and are kept. Open screens reload themselves when the new version is up.

## Troubleshooting

| Problem | Check |
|---|---|
| Installer: "needs passwordless sudo" | Run the command it prints on the Pi, or use the first user of Raspberry Pi OS. |
| Build fails with `EAI_AGAIN` or other DNS errors | Re-run `./install.sh` and enter your router's IP and `1.1.1.1` as build DNS servers. |
| "Port 80/443 is already in use" | Another web server runs on the Pi; stop it, or Caddy cannot start. |
| Page does not load | `ssh <pi> sudo systemctl status nexus caddy` and `sudo journalctl -u nexus -n 50` |
| Certificate warning | Trust the root certificate (step 4) on that device. |
| Home Assistant returns 400 | The `trusted_proxies` step above. |
| Spotify login fails with "INVALID_CLIENT: Invalid redirect URI" | The redirect URI in the Spotify app must match `PUBLIC_URL` exactly. |

## Uninstalling

On the Pi:

```sh
sudo systemctl stop nexus caddy homeassistant nexus-snapshot.timer
sudo systemctl disable nexus-snapshot.timer
sudo rm /etc/containers/systemd/{nexus.network,nexus.container,caddy.container,homeassistant.container}
sudo rm /etc/systemd/system/nexus-snapshot.{service,timer} /etc/tmpfiles.d/nexus.conf
sudo systemctl daemon-reload
```

That leaves your data. To delete it too (settings, shortcuts, Home Assistant, certificates), which cannot be undone:
`sudo podman volume rm nexus-data nexus-caddy-data homeassistant-config && sudo rm -r /etc/nexus ~/nexus`.
