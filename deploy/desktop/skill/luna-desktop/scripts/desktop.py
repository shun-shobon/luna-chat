#!/usr/bin/python3
"""Operate Luna's desktop (DISPLAY :99) through AT-SPI and xdotool."""

# Why the system interpreter: PyGObject comes from apt, and a login shell puts mise's python3 first.

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import time
import warnings

SESSION_ENV = "/opt/luna-desktop/etc/session.env"
MAX_NODES = 4000
ACTION_PREFERENCE = ("press", "click", "jump", "activate", "select", "open", "toggle", "doDefault")
# Roles worth listing even without an action, so Luna can read the screen from the tree.
READABLE_ROLES = {"heading", "label", "static", "text", "paragraph", "entry", "password text", "image", "status bar", "alert", "notification", "list item", "table cell"}


def load_session_env():
    with open(SESSION_ENV, encoding="utf-8") as handle:
        for line in handle:
            key, sep, value = line.strip().partition("=")
            if sep and key and key not in os.environ:
                os.environ[key] = value


load_session_env()

import gi  # noqa: E402

gi.require_version("Atspi", "2.0")
gi.require_version("Gdk", "3.0")
from gi.repository import Atspi, Gdk  # noqa: E402

# Why: AT-SPI 2.52 on Ubuntu 24.04 marks get_action_name deprecated but ships no replacement in its GIR.
warnings.filterwarnings("ignore", category=DeprecationWarning)

RUNTIME_DIR = os.environ["XDG_RUNTIME_DIR"]
ELEMENTS_FILE = os.path.join(RUNTIME_DIR, "desktop-elements.json")
SCREENS_DIR = os.path.join(RUNTIME_DIR, "screens")
LAST_SCREEN_FILE = os.path.join(RUNTIME_DIR, "desktop-last-screen.json")
KEEP_SCREENS = 30


def fail(message):
    print(json.dumps({"ok": False, "error": message}, ensure_ascii=False))
    sys.exit(1)


def attempt(fn, fallback=None):
    try:
        value = fn()
        return fallback if value is None else value
    except Exception:
        return fallback


def xdotool(*args):
    subprocess.run(["xdotool", *[str(a) for a in args]], check=True)


# --- screenshots -------------------------------------------------------------


def take_screenshot(crop=None):
    root = Gdk.get_default_root_window()
    pixbuf = Gdk.pixbuf_get_from_window(root, 0, 0, root.get_width(), root.get_height())
    if pixbuf is None:
        fail("screenshot failed")
    digest = hashlib.sha256(pixbuf.get_pixels()).hexdigest()
    if crop:
        x, y, w, h = crop
        pixbuf = pixbuf.new_subpixbuf(x, y, w, h)
    os.makedirs(SCREENS_DIR, mode=0o700, exist_ok=True)
    path = os.path.join(SCREENS_DIR, time.strftime("%Y%m%d-%H%M%S-") + f"{time.time_ns() % 1_000_000:06d}.png")
    pixbuf.savev(path, "png", [], [])
    for old in sorted(os.listdir(SCREENS_DIR))[:-KEEP_SCREENS]:
        os.remove(os.path.join(SCREENS_DIR, old))
    return path, digest


def remember_screen(digest):
    with open(LAST_SCREEN_FILE, "w", encoding="utf-8") as handle:
        json.dump({"digest": digest}, handle)


def previous_screen_digest():
    return attempt(lambda: json.load(open(LAST_SCREEN_FILE, encoding="utf-8"))["digest"])


def after_action(result, settle):
    time.sleep(settle)
    before = previous_screen_digest()
    path, digest = take_screenshot()
    remember_screen(digest)
    result["screenshot"] = path
    # Why: an AT-SPI action or synthetic input can succeed without any effect; a still screen is the cheap signal.
    result["screenChanged"] = None if before is None else before != digest
    print(json.dumps(result, ensure_ascii=False))


# --- accessibility tree ------------------------------------------------------


def desktop_apps():
    desktop = Atspi.get_desktop(0)
    return [app for app in (attempt(lambda i=i: desktop.get_child_at_index(i)) for i in range(desktop.get_child_count())) if app]


def find_app(query):
    apps = desktop_apps()
    if not query:
        active = [app for app in apps if any(has_state(win, Atspi.StateType.ACTIVE) for win in children(app))]
        if active:
            return active[0]
        fail("no active window; pass --app (see `apps`)")
    lowered = query.lower()
    for app in apps:
        if lowered in (attempt(app.get_name, "") or "").lower():
            return app
    fail(f"app not found: {query}; run `apps`")


def children(node):
    return [child for child in (attempt(lambda i=i: node.get_child_at_index(i)) for i in range(attempt(node.get_child_count, 0))) if child]


def has_state(node, state):
    states = attempt(node.get_state_set)
    return bool(states and states.contains(state))


def actions_of(node):
    iface = attempt(node.get_action_iface)
    if not iface:
        return []
    return [attempt(lambda i=i: Atspi.Action.get_action_name(iface, i), "") for i in range(attempt(iface.get_n_actions, 0))]


def extents(node):
    rect = attempt(lambda: node.get_extents(Atspi.CoordType.SCREEN))
    return (rect.x, rect.y, rect.width, rect.height) if rect else None


def value_of(node, role):
    if role == "password text":
        return "<hidden>"
    text = attempt(node.get_text_iface)
    if text:
        count = attempt(lambda: Atspi.Text.get_character_count(text), 0)
        value = attempt(lambda: Atspi.Text.get_text(text, 0, min(count, 200)), "")
        return value if value else None
    value = attempt(node.get_value_iface)
    if value:
        return str(attempt(value.get_current_value, ""))
    return None


def walk(app, query):
    records, lines = [], []

    def visit(node, path, depth):
        if len(records) >= MAX_NODES:
            return
        role = attempt(node.get_role_name, "")
        name = (attempt(node.get_name, "") or "").strip()
        box = extents(node)
        visible = box is not None and box[2] > 0 and box[3] > 0 and has_state(node, Atspi.StateType.SHOWING)
        actions = [a for a in actions_of(node) if a and a not in ("showContextMenu", "clickAncestor")]
        value = value_of(node, role) if visible else None
        listed = visible and (actions or (role in READABLE_ROLES and (name or value)))
        next_depth = depth
        if listed:
            line = f"{role} {name!r}" + (f" value={value!r}" if value and value != name else "")
            line += f" @({box[0]},{box[1]} {box[2]}x{box[3]})" + (f" [{', '.join(actions)}]" if actions else "")
            if not query or query.lower() in line.lower():
                index = len(records) + 1
                records.append({"index": index, "path": path, "role": role, "name": name, "box": box})
                lines.append(f"{'  ' * depth}[{index}] {line}")
            next_depth = depth + 1
        for i, child in enumerate(children(node)):
            visit(child, path + [i], next_depth)

    visit(app, [], 0)
    return records, lines


def resolve(index):
    saved = attempt(lambda: json.load(open(ELEMENTS_FILE, encoding="utf-8")))
    if not saved:
        fail("no element list; run `state` first")
    record = next((r for r in saved["elements"] if r["index"] == index), None)
    if record is None:
        fail(f"index {index} is not in the last `state`; run `state` again")
    node = find_app(saved["app"])
    for step in record["path"]:
        kids = children(node)
        if step >= len(kids):
            fail(f"element [{index}] is gone; run `state` again")
        node = kids[step]
    if attempt(node.get_role_name, "") != record["role"] or (attempt(node.get_name, "") or "").strip() != record["name"]:
        fail(f"element [{index}] changed since `state`; run `state` again")
    return node, record


def focused_text_node(app):
    stack, seen = [app], 0
    while stack and seen < MAX_NODES:
        node = stack.pop()
        seen += 1
        if has_state(node, Atspi.StateType.FOCUSED) and attempt(node.get_text_iface):
            return node
        stack.extend(reversed(children(node)))
    return None


def center(record):
    x, y, w, h = record["box"]
    return x + w // 2, y + h // 2


# --- commands ----------------------------------------------------------------


def cmd_apps(_args):
    apps = [{"name": attempt(a.get_name, ""), "pid": attempt(a.get_process_id), "windows": [attempt(w.get_name, "") for w in children(a)]} for a in desktop_apps()]
    windows = subprocess.run(["wmctrl", "-lp"], capture_output=True, text=True).stdout.strip().splitlines()
    print(json.dumps({"ok": True, "apps": apps, "x11Windows": windows}, ensure_ascii=False))


def cmd_state(args):
    app = find_app(args.app)
    records, lines = walk(app, args.query)
    with open(ELEMENTS_FILE, "w", encoding="utf-8") as handle:
        json.dump({"app": attempt(app.get_name, ""), "elements": records}, handle)
    path, digest = take_screenshot()
    remember_screen(digest)
    print(f"app: {attempt(app.get_name, '')}  elements: {len(records)}  screenshot: {path}")
    shown = lines[: args.max]
    indent = min((len(line) - len(line.lstrip(" ")) for line in shown), default=0)
    print("\n".join(line[indent:] for line in shown))
    if len(lines) > args.max:
        print(f"... {len(lines) - args.max} more; narrow with --query")


def cmd_click(args):
    if args.index is not None:
        node, record = resolve(args.index)
        names = actions_of(node)
        if args.button == "left" and not args.double:
            for wanted in ACTION_PREFERENCE:
                if wanted in names and attempt(lambda: node.get_action_iface().do_action(names.index(wanted)), False):
                    return after_action({"ok": True, "via": f"accessibility:{wanted}", "index": args.index}, args.settle)
        x, y = center(record)
    elif args.x is not None and args.y is not None:
        x, y = args.x, args.y
    else:
        fail("pass --index or --x/--y")
    button = {"left": 1, "middle": 2, "right": 3}[args.button]
    xdotool("mousemove", x, y)
    xdotool("click", *(["--repeat", 2, "--delay", 80] if args.double else []), button)
    after_action({"ok": True, "via": "pointer", "x": x, "y": y}, args.settle)


def enter_text(text):
    if text.isascii():
        xdotool("type", "--delay", 30, "--", text)
        return
    # Why paste: xdotool type drops non-ASCII characters on Xvfb's keymap (e.g. "ねこ" becomes "ね").
    # xclip stays in the background to serve the clipboard, so it must not hold the caller's output pipes.
    subprocess.run(["xclip", "-selection", "clipboard"], input=text.encode(), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)
    xdotool("key", "ctrl+v")


def read_text(args):
    return sys.stdin.read() if args.stdin else args.text


def cmd_set_value(args):
    node, record = resolve(args.index)
    text = read_text(args)
    editable = attempt(node.get_editable_text_iface)
    via = "accessibility:set_text_contents"
    if not (editable and attempt(lambda: Atspi.EditableText.set_text_contents(editable, text), False) and value_of(node, record["role"]) == text):
        # Why: Chrome's omnibox and many web inputs reject set_text_contents, but accept focus + select-all + typing.
        via = "keyboard"
        if not attempt(lambda: Atspi.Component.grab_focus(node), False):
            xdotool("mousemove", *center(record))
            xdotool("click", 1)
        xdotool("key", "ctrl+a")
        enter_text(text)
    app = find_app(json.load(open(ELEMENTS_FILE, encoding="utf-8"))["app"])

    def current_value():
        # Why the focused node: web inputs such as search boxes turn into a new combo box node once text is typed.
        value = value_of(node, record["role"])
        if value is None and (focused := focused_text_node(app)) is not None:
            value = value_of(focused, attempt(focused.get_role_name, ""))
        return value

    # Why poll: Chrome updates its accessibility tree asynchronously, so an immediate read returns the old value.
    deadline = time.monotonic() + 2
    while (current := current_value()) != text and time.monotonic() < deadline:
        time.sleep(0.2)
    after_action({"ok": True, "via": via, "index": args.index, "verified": current == text, "value": current}, args.settle)


def cmd_type(args):
    enter_text(read_text(args))
    after_action({"ok": True, "via": "keyboard"}, args.settle)


def cmd_key(args):
    xdotool("key", "--delay", 60, *args.keys)
    after_action({"ok": True, "via": "keyboard", "keys": args.keys}, args.settle)


def cmd_scroll(args):
    button = {"up": 4, "down": 5, "left": 6, "right": 7}[args.direction]
    xdotool("mousemove", args.x, args.y)
    xdotool("click", "--repeat", args.amount, "--delay", 60, button)
    after_action({"ok": True, "via": "pointer", "direction": args.direction}, args.settle)


def cmd_drag(args):
    (fx, fy), (tx, ty) = args.from_point, args.to_point
    xdotool("mousemove", fx, fy)
    xdotool("mousedown", 1)
    for step in range(1, 11):
        xdotool("mousemove", fx + (tx - fx) * step // 10, fy + (ty - fy) * step // 10)
        time.sleep(0.03)
    xdotool("mouseup", 1)
    after_action({"ok": True, "via": "pointer"}, args.settle)


def cmd_screenshot(args):
    path, digest = take_screenshot(args.crop)
    if not args.crop:
        remember_screen(digest)
    print(json.dumps({"ok": True, "screenshot": path}, ensure_ascii=False))


def cmd_activate(args):
    subprocess.run(["wmctrl", "-ia", args.window], check=True)
    after_action({"ok": True, "window": args.window}, args.settle)


def cmd_wallpaper(args):
    wallpaper = os.path.expanduser("~/.luna/desktop/wallpaper")
    shutil.copyfile(args.image, wallpaper + ".new")
    os.replace(wallpaper + ".new", wallpaper)
    subprocess.run(["feh", "--no-fehbg", "--bg-fill", wallpaper], check=True)
    after_action({"ok": True, "wallpaper": wallpaper}, args.settle)


def point(value):
    x, y = value.split(",")
    return int(x), int(y)


def rect(value):
    x, y, w, h = (int(v) for v in value.split(","))
    return x, y, w, h


def main():
    parser = argparse.ArgumentParser(prog="desktop.py")
    sub = parser.add_subparsers(dest="command", required=True)

    def action(name, handler, help_text):
        p = sub.add_parser(name, help=help_text)
        p.add_argument("--settle", type=float, default=0.8, help="seconds to wait before the after-action screenshot")
        p.set_defaults(handler=handler)
        return p

    sub.add_parser("apps", help="list accessible apps and X windows").set_defaults(handler=cmd_apps)
    p = sub.add_parser("state", help="list the elements of an app with indexes, and take a screenshot")
    p.add_argument("--app", help="app name substring (default: the app with the active window)")
    p.add_argument("--query", help="only list elements whose line contains this text")
    p.add_argument("--max", type=int, default=300)
    p.set_defaults(handler=cmd_state)
    p = action("click", cmd_click, "click an element from the last `state`, or a screen point")
    p.add_argument("--index", type=int)
    p.add_argument("--x", type=int)
    p.add_argument("--y", type=int)
    p.add_argument("--button", choices=("left", "middle", "right"), default="left")
    p.add_argument("--double", action="store_true")
    p = action("set-value", cmd_set_value, "replace the text of an editable element")
    p.add_argument("--index", type=int, required=True)
    group = p.add_mutually_exclusive_group(required=True)
    group.add_argument("--text")
    group.add_argument("--stdin", action="store_true")
    p = action("type", cmd_type, "type text into the focused element")
    group = p.add_mutually_exclusive_group(required=True)
    group.add_argument("--text")
    group.add_argument("--stdin", action="store_true")
    p = action("key", cmd_key, "press keys, e.g. Return, ctrl+l, alt+Tab")
    p.add_argument("keys", nargs="+")
    p = action("scroll", cmd_scroll, "scroll at a screen point")
    p.add_argument("--x", type=int, required=True)
    p.add_argument("--y", type=int, required=True)
    p.add_argument("--direction", choices=("up", "down", "left", "right"), required=True)
    p.add_argument("--amount", type=int, default=3)
    p = action("drag", cmd_drag, "drag with the left button")
    p.add_argument("--from", dest="from_point", type=point, required=True, help="X,Y")
    p.add_argument("--to", dest="to_point", type=point, required=True, help="X,Y")
    p = sub.add_parser("screenshot", help="save a screenshot of the whole screen or a region")
    p.add_argument("--crop", type=rect, help="X,Y,W,H")
    p.set_defaults(handler=cmd_screenshot)
    p = action("activate", cmd_activate, "bring an X window (id from `apps`) to the front")
    p.add_argument("--window", required=True)
    p = action("wallpaper", cmd_wallpaper, "set the desktop wallpaper (kept across restarts)")
    p.add_argument("--image", required=True, help="image file; it is scaled to cover the 1440x900 screen")

    args = parser.parse_args()
    try:
        args.handler(args)
    except subprocess.CalledProcessError as exc:
        fail(f"{exc.cmd[0]} failed with exit code {exc.returncode}")


if __name__ == "__main__":
    main()
