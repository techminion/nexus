"""Export viewer models (shell + placeholder hardware) and check hardware clearance.  python export_viewer.py"""
import base64, json, math
from pathlib import Path
import cadquery as cq
import enclosure as E
from enclosure import box, on_face

OUT = Path(__file__).parent / "viewer"; OUT.mkdir(exist_ok=True)
C = lambda *rgb: cq.Color(*rgb)


def hardware():
    hw = {}
    hw["pi"] = box(E.PI_X, E.PI_Y, E.PI_Z, 56, 85, 1.6)
    hw["pi_ports"] = box(E.PI_X + 2, E.PI_Y + 64, E.PI_Z + 1.6, 53, 23, 15.5)
    hw["pi_heatsink"] = box(E.PI_X + 15, E.PI_Y + 20, E.PI_Z + 1.6, 30, 30, 12)
    hw["gpio_ribbon"] = box(E.PI_X + 56 - 6, E.PI_Y + 7, E.PI_Z + 1.6, 6, 51, 9)   # header + plug on the Pi
    y0, ly, z0, lz = E.SIDE_R
    hw["box_header"] = box(E.W - E.WALL - 9, y0 + ly / 2 - 28, z0 + lz / 2 - 4.5, 9, 56, 9)
    hw["proto"] = box(E.ESP_X, E.ESP_Y, E.PLATE_T + 5, 70, 50, 1.6)
    hw["esp32"] = box(E.ESP_X + 2, E.ESP_Y + 11, E.PLATE_T + 6.6, 55, 28, 9)
    hw["fan"] = box(E.FAN_X - 20, E.DEPTH - E.WALL - 10.2, E.FAN_Z - 20, 40, 10, 40)
    return hw


def display():
    x0, u0 = (E.W - E.POCKET_W) / 2 + E.FIT, E.BORDER_U + E.FIT
    panel = box(x0, 0, u0, E.DISP_W, E.DISP_T, E.DISP_H)
    glass = box(x0 + 5, -0.05, u0 + 6, E.DISP_W - 10, 0.1, E.DISP_H - 12)
    return on_face(panel, E.B, E.TILT), on_face(glass, E.B, E.TILT)


def check(shell, hw):
    bad = 0
    for name, s in hw.items():
        v = s.intersect(shell).val().Volume()
        print(f"  {name:12s} overlap with shell {v:8.1f} mm^3")
        bad += v > 1
    return bad


def glb(parts, name):
    a = cq.Assembly()
    for n, (shape, col) in parts.items():
        a.add(shape, name=n, color=C(*col))
    path = OUT / f"{name}.glb"
    a.export(str(path))
    return path


if __name__ == "__main__":
    shell, plate = E.shell(), E.bottom_plate()
    hw = hardware()
    print("clearance:"); bad = check(shell, hw)
    panel, glass = display()
    print(f"  display      overlap with shell {panel.intersect(shell).val().Volume():8.1f} mm^3")

    files = {}
    files["shell"] = glb({"shell": (shell, (0.86, 0.85, 0.82))}, "shell")
    files["inside"] = glb({
        "plate": (plate, (0.55, 0.56, 0.58)),
        "pi": (hw["pi"], (0.1, 0.45, 0.25)), "pi_ports": (hw["pi_ports"], (0.72, 0.73, 0.76)),
        "pi_heatsink": (hw["pi_heatsink"], (0.25, 0.26, 0.3)),
        "gpio_ribbon": (hw["gpio_ribbon"], (0.6, 0.62, 0.7)), "box_header": (hw["box_header"], (0.12, 0.12, 0.13)),
        "proto": (hw["proto"], (0.75, 0.6, 0.3)), "esp32": (hw["esp32"], (0.15, 0.2, 0.45)),
        "fan": (hw["fan"], (0.12, 0.12, 0.13)),
    }, "inside")
    files["display"] = glb({"panel": (panel, (0.05, 0.06, 0.08)), "glass": (glass, (0.16, 0.33, 0.52))}, "display")
    for kind in ("gpio", "blank"):
        files[f"right_{kind}"] = glb({"plate": (E.side_plate_world(kind, False), (0.24, 0.25, 0.28))}, f"right_{kind}")
    for kind in ("esp32", "blank"):
        files[f"left_{kind}"] = glb({"plate": (E.side_plate_world(kind, True), (0.24, 0.25, 0.28))}, f"left_{kind}")

    bundle = {k + ".glb": base64.b64encode(p.read_bytes()).decode() for k, p in files.items()}
    (OUT / "models.js").write_text("window.DOCK_MODELS=" + json.dumps(bundle) + ";")
    for p in files.values():
        p.unlink()
    print("models.js", (OUT / "models.js").stat().st_size, "bytes; W", round(E.W, 1), "top", round(E.TOP_Z, 1))
    raise SystemExit(1 if bad else 0)
