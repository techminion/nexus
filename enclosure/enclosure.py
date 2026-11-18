"""Desk dock v2: Waveshare 12.3" 1920x720 touch display (flush, fixed tilt) + Raspberry Pi 4 + ESP32.

Run:  python enclosure.py      -> writes STL for every printable part into ./out
Units: mm.  World axes: X = width (left->right), Y = depth (front->back), Z = up.
Side profile (Y,Z):   front wall up to FRONT_H, display slope at TILT from vertical,
                      short flat cap, rear face down to a vertical rear wall that carries the Pi ports.
"""
import math
from pathlib import Path
import cadquery as cq

# ---------------- parameters (measure your parts and adjust) ----------------
DISP_W, DISP_H, DISP_T = 301.2, 123.35, 12.4   # Waveshare wiki outline; verify on your unit
FIT = 0.3             # clearance per side around the panel
TAPE = 0.5            # VHB tape under the panel rim -> glass ends flush
LEDGE = 4.0           # support ledge under the panel rim
BORDER_X, BORDER_U = 7.0, 5.0   # shell border beside / above+below the pocket

TILT = 60.0           # display tilt back from vertical (deg) -> 30 deg from the desk
FRONT_H = 30.0        # plain front face height
REAR_RUN = 12.0       # how far the rear face reaches past the top cap
REAR_H = 45.0         # vertical rear wall height (Pi ports live here)
CAP = 8.0             # flat top cap depth
WALL = 3.0
TUB_T = DISP_T + TAPE + 3.0     # depth of the rim that holds the panel behind the thin slope wall
FILLET = 3.0

M3, M3_INSERT = 3.2, 4.2
PLATE_T = 3.0         # bottom plate

# Pi 4 (85 x 56, holes 58 x 49 @ 3.5 from edges); GPIO edge faces the right wall
PI_STANDOFF = 6.0
PI_GAP_R = 16.0       # room between Pi and right wall for the ribbon fold
# ESP32 sled: 50 x 70 proto board (holes 46 x 66), USB end toward the left wall
ESP_X, ESP_Y = 14.0, 40.0
# Side port plates (y start, length, z start, height) - left: ESP32, right: GPIO
SIDE_L = (60.0, 65.0, 12.0, 22.0)
SIDE_R = (60.0, 65.0, 12.0, 22.0)
FAN = 40.0; FAN_HOLES = 32.0

# ---------------- derived ----------------
POCKET_W, POCKET_H = DISP_W + 2 * FIT, DISP_H + 2 * FIT
W = POCKET_W + 2 * BORDER_X
SLOPE_L = POCKET_H + 2 * BORDER_U
_s, _c = math.sin(math.radians(TILT)), math.cos(math.radians(TILT))
B = (0.0, FRONT_H)                                    # bottom of display slope
C = (SLOPE_L * _s, FRONT_H + SLOPE_L * _c)            # top of display slope
TOP_Z = C[1]
Dp = (C[0] + CAP, TOP_Z)                              # rear of cap
DEPTH = Dp[0] + REAR_RUN
E = (DEPTH, REAR_H)                                   # top of rear vertical wall
SPLIT_X = W / 2
PI_X = W - WALL - PI_GAP_R - 56
PI_Y = DEPTH - WALL - 1 - 85
PI_Z = PLATE_T + PI_STANDOFF
FAN_X, FAN_Z = PI_X - 28, PLATE_T + 1 + FAN / 2


def box(x0, y0, z0, dx, dy, dz):
    return cq.Workplane("XY").box(dx, dy, dz, centered=False).translate((x0, y0, z0))


def cyl_x(x0, length, y, z, d):
    return cq.Workplane("YZ").circle(d / 2).extrude(length).translate((x0, y, z))


def cyl_y(x, y0, length, z, d):
    return cq.Workplane("XZ").circle(d / 2).extrude(-length).translate((x, y0, z))


def cyl_z(x, y, z0, h, d):
    return cq.Workplane("XY").circle(d / 2).extrude(h).translate((x, y, z0))


def on_face(shape, origin, tilt_deg):
    """Map a shape built in a 'face-local' frame (X across, Y = into the body, Z = up the face)
    onto a face through `origin` (y, z) leaning back by tilt_deg (negative = leaning forward)."""
    return shape.rotate((0, 0, 0), (1, 0, 0), -tilt_deg).translate((0, origin[0], origin[1]))


# ---------------- profile ----------------
def outer_pts():
    return [(0, 0), (DEPTH, 0), E, Dp, C, B]          # CCW in (Y, Z)


def offset_poly(pts, offs):
    """Inward offset of a CCW polygon, one offset per edge (edge i = pts[i] -> pts[i+1])."""
    n, lines = len(pts), []
    for i in range(n):
        (y1, z1), (y2, z2) = pts[i], pts[(i + 1) % n]
        dy, dz = y2 - y1, z2 - z1; L = math.hypot(dy, dz)
        ny, nz = -dz / L, dy / L                       # left normal = inward
        lines.append(((y1 + ny * offs[i], z1 + nz * offs[i]), (dy, dz)))
    out = []
    for i in range(n):
        (p, d), (q, e) = lines[i - 1], lines[i]
        den = d[0] * e[1] - d[1] * e[0]
        t = ((q[0] - p[0]) * e[1] - (q[1] - p[1]) * e[0]) / den
        out.append((p[0] + t * d[0], p[1] + t * d[1]))
    return out


def inner_pts():
    # floor, rear wall, rear slope, cap, display slope, front wall
    return offset_poly(outer_pts(), [-1.0, WALL, WALL, WALL, WALL, WALL])


def prism(pts, x0, length):
    return cq.Workplane("YZ").polyline(pts).close().extrude(length).translate((x0, 0, 0))


# ---------------- shell ----------------
def shell():
    outer = prism(outer_pts(), 0, W)
    try:
        outer = outer.edges("not <Z").fillet(FILLET)
    except Exception:
        pass   # keep sharp edges if the kernel refuses the fillet
    s = outer.cut(prism(inner_pts(), WALL, W - 2 * WALL))

    # display pocket (flush) + window, leaving a LEDGE-wide rim for tape
    x0, u0 = (W - POCKET_W) / 2, BORDER_U
    tub = on_face(box(x0 - 3, 0, u0 - 3, POCKET_W + 6, TUB_T, POCKET_H + 6), B, TILT)
    s = s.union(tub.intersect(prism(outer_pts(), 0, W)))
    pocket = box(x0, -1, u0, POCKET_W, 1 + DISP_T + TAPE, POCKET_H)
    window = box(x0 + LEDGE, -1, u0 + LEDGE, POCKET_W - 2 * LEDGE, TUB_T + 4, POCKET_H - 2 * LEDGE)
    s = s.cut(on_face(pocket.union(window), B, TILT))

    # bottom plate bosses (corners + either side of the seam)
    for x, y in plate_screws():
        s = s.union(cyl_z(x, y, PLATE_T, 12, 8)).cut(cyl_z(x, y, PLATE_T - 0.1, 9, M3_INSERT))

    # side port openings with an inner mounting frame
    for x_wall, (y0, ly, z0, lz), inward in ((0.0, SIDE_L, 1), (W, SIDE_R, -1)):
        frame_x = WALL if inward > 0 else W - WALL - 5
        s = s.union(box(frame_x, y0 - 8, z0 - 8, 5, ly + 16, lz + 16))
        s = s.cut(box(-1 if inward > 0 else W - 2.0, y0 - 9, z0 - 9, 3.0, ly + 18, lz + 18))   # flush recess
        s = s.cut(box(-1 if inward > 0 else W - WALL - 6, y0, z0, WALL + 7, ly, lz))
        for y, z in side_screws(y0, ly, z0, lz):
            s = s.cut(cyl_x(-1 if inward > 0 else W - WALL - 9, WALL + 10, y, z, M3_INSERT))

    # Pi rear ports (USB x4 + Ethernet)
    s = s.cut(box(PI_X - 1, DEPTH - WALL - 1, PI_Z + 1.4, 58, WALL + 2, 18))
    # rear cable slot (power, ESP32, extras) behind the ESP32 bench
    s = s.cut(box(PI_X - 200, DEPTH - WALL - 1, PLATE_T + 3, 60, WALL + 2, 12).edges("|Y").fillet(3))

    # exhaust fan on the rear wall, just left of the Pi ports (intake: floor vents under the Pi)
    grille = None
    for i in range(-3, 4):
        for j in range(-3, 4):
            px, pz = i * 5.2 + (2.6 if j % 2 else 0), j * 4.5
            if math.hypot(px, pz) < FAN / 2 - 3:
                h = cyl_y(FAN_X + px, DEPTH - WALL - 1, WALL + 2, FAN_Z + pz, 3.6)
                grille = h if grille is None else grille.union(h)
    for dx in (-1, 1):
        for dz in (-1, 1):
            grille = grille.union(cyl_y(FAN_X + dx * FAN_HOLES / 2, DEPTH - WALL - 1, WALL + 2, FAN_Z + dz * FAN_HOLES / 2, M3))
    s = s.cut(grille)

    # seam splice bosses (rear wall inside; the front is too low, the bottom plate bridges it)
    for y_wall, d in ((DEPTH - WALL, -1),):
        for dx in (-12, 12):
            for z in (PLATE_T + 18, PLATE_T + 32):
                y0 = y_wall if d > 0 else y_wall - 5
                s = s.union(box(SPLIT_X + dx - 4, y0, z - 4, 8, 5, 8))
                s = s.cut(cyl_y(SPLIT_X + dx, y_wall - 0.1 if d > 0 else y_wall - 8.1, 8, z, M3_INSERT))
    return s


def plate_screws():
    xs = [WALL + 7, SPLIT_X - 50 - 8, SPLIT_X - 50 + 8, W - WALL - 7]
    return [(x, y) for x in xs for y in (WALL + 7, DEPTH - WALL - 7)]


def side_screws(y0, ly, z0, lz):
    return [(y, z) for y in (y0 - 4.5, y0 + ly + 4.5) for z in (z0 + 5, z0 + lz - 5)]


# ---------------- other parts ----------------
def bottom_plate():
    p = box(WALL + 0.3, WALL + 0.3, 0, W - 2 * WALL - 0.6, DEPTH - 2 * WALL - 0.6, PLATE_T)
    for x, y in plate_screws():
        p = p.cut(cyl_z(x, y, -1, PLATE_T + 2, M3)).cut(cyl_z(x, y, -1, 1.9, 6.2))   # countersink-ish
    for hx, hy in [(3.5, 3.5), (52.5, 3.5), (3.5, 61.5), (52.5, 61.5)]:
        x, y = PI_X + hx, PI_Y + hy
        p = p.union(cyl_z(x, y, PLATE_T, PI_STANDOFF, 6)).cut(cyl_z(x, y, 1, PI_STANDOFF + 3, 2.5))
    for hx, hy in [(2, 2), (68, 2), (2, 48), (68, 48)]:
        x, y = ESP_X + hx, ESP_Y + hy
        p = p.union(cyl_z(x, y, PLATE_T, 5, 6)).cut(cyl_z(x, y, 1, 8, 2.5))
    for i in range(6):   # intake under the Pi
        p = p.cut(box(PI_X + 8, PI_Y + 12 + i * 9, -1, 40, 4, PLATE_T + 2))
    # rubber-foot recesses (10 mm bumpons)
    for x in (20, W - 20):
        for y in (15, DEPTH - 15):
            p = p.cut(cyl_z(x, y, -0.1, 0.8, 10.5))
    return p


def splice_plate():
    p = box(-20, 0, -11, 40, 3, 22)
    for dx in (-12, 12):
        for dz in (-7, 7):
            p = p.cut(cyl_y(dx, -1, 5, dz, M3))
    return p


def side_plate(kind, spec):
    """Side panel in local (Y, Z) centred on the opening. 'gpio' = 2x20 box header, 'esp32' = USB-C + header slot."""
    y0, ly, z0, lz = spec
    p = cq.Workplane("YZ").rect(ly + 18, lz + 18).extrude(2.0).edges("|X").fillet(2)
    for y, z in side_screws(-ly / 2, ly, -lz / 2, lz):
        p = p.cut(cyl_x(-1, 4, y, z, M3))
    if kind == "gpio":
        p = p.cut(box(-1, -28.3, -4.8, 4, 56.6, 9.6))                    # 2x20 IDC box header shroud
        for y in (-22, 22):
            p = p.cut(cyl_x(-1, 4, y, 9, 6.2))                           # 2x spare 6 mm holes (LED / switch)
    elif kind == "esp32":
        p = p.cut(box(-1, -25, -lz / 2 + 4, 4, 13, 7).edges("|X").fillet(2.5))   # USB-C
        p = p.cut(box(-1, -5, -1.5, 4, 30, 3.2))                          # 1x12 header slot
        p = p.cut(box(-1, -5, 6, 4, 30, 3.2))
    return p


def side_plate_world(kind, left):
    spec = SIDE_L if left else SIDE_R
    y0, ly, z0, lz = spec
    p = side_plate(kind, spec)
    return p.translate((0, y0 + ly / 2, z0 + lz / 2)) if left else p.translate((W - 2.0, y0 + ly / 2, z0 + lz / 2))


# ---------------- split + export ----------------
def halves(shape, split_x):
    big = 2000
    return (shape.intersect(box(-big / 2, -big / 2, -big / 2, split_x + big / 2, big, big)),
            shape.intersect(box(split_x, -big / 2, -big / 2, big, big, big)))


def export(outdir="out"):
    out = Path(__file__).parent / outdir
    out.mkdir(exist_ok=True)
    for f in out.glob("*.stl"):
        f.unlink()   # drop parts from older versions
    sh_l, sh_r = halves(shell(), SPLIT_X)
    pl_l, pl_r = halves(bottom_plate(), SPLIT_X - 50)   # offset seam so the plate bridges the shell seam
    printable = {
        "shell_left": sh_l, "shell_right": sh_r,
        "bottom_left": pl_l, "bottom_right": pl_r,
        "splice_plate": splice_plate(),
        "side_gpio": side_plate("gpio", SIDE_R), "side_esp32": side_plate("esp32", SIDE_L),
        "side_blank": side_plate("blank", SIDE_R),
    }
    for name, s in printable.items():
        cq.exporters.export(s, str(out / f"{name}.stl"))
        bb = s.val().BoundingBox()
        print(f"{name:18s} {bb.xlen:6.1f} x {bb.ylen:6.1f} x {bb.zlen:6.1f}")


if __name__ == "__main__":
    print(f"overall W={W:.1f} D={DEPTH} H={TOP_Z:.1f}  display bottom edge z={FRONT_H + BORDER_U * _c:.1f}")
    print("inner profile:", [(round(y, 1), round(z, 1)) for y, z in inner_pts()])
    export()
