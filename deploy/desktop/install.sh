#!/usr/bin/env bash
# Ubuntu 24.04 のホストへルナのデスクトップを入れる。root で実行し、何度実行してもよい。
set -euo pipefail

LUNA_USER=luna
LUNA_HOME=/home/luna/.luna
GO_VERSION=1.25.14
GO_SHA256=a21ae5633a269bcd7e90cf767e48225633795e99d831742cbf3397064fee7712
NEKO_TAG=v3.2.0
NEKO_COMMIT=92420ca8e4709c1ac49961c4bf5d3cc786d44f0d
# ghcr.io/m1k1o/neko/base:3.2.0（linux/amd64）のうち、閲覧画面の静的ファイル（/var/www）だけを含むレイヤー
NEKO_WWW_IMAGE=m1k1o/neko/base
NEKO_WWW_LAYER=sha256:b0b9cf484422f9631af2df60d17e1c6bc1b56687fce53d85ee748194e8a2ec07
GOOGLE_KEY_FINGERPRINT=EB4C1BFD4F042F6DDDCCEC917721F63BD38B4796

HERE=$(cd "$(dirname "$0")" && pwd)
PREFIX=/opt/luna-desktop
BUILD=$(mktemp -d)
trap 'rm -rf "$BUILD"' EXIT

export DEBIAN_FRONTEND=noninteractive

install -d -m 0755 /etc/apt/keyrings
if [[ ! -f /etc/apt/keyrings/google-linux.gpg ]]; then
	curl -fsSL https://dl.google.com/linux/linux_signing_key.pub -o "$BUILD/google.pub"
	gpg --show-keys --with-colons "$BUILD/google.pub" | grep -q "^fpr:::::::::$GOOGLE_KEY_FINGERPRINT:"
	gpg --dearmor <"$BUILD/google.pub" >/etc/apt/keyrings/google-linux.gpg
	chmod 0644 /etc/apt/keyrings/google-linux.gpg
fi
cat >/etc/apt/sources.list.d/google-chrome.sources <<'EOF'
Types: deb
URIs: https://dl.google.com/linux/chrome/deb/
Suites: stable
Components: main
Architectures: amd64
Signed-By: /etc/apt/keyrings/google-linux.gpg
EOF
apt-get update
apt-get install -y --no-install-recommends \
	google-chrome-stable xvfb openbox xdotool wmctrl xclip dbus-x11 pulseaudio \
	at-spi2-core python3-gi gir1.2-atspi-2.0 gir1.2-gtk-3.0 gir1.2-gdkpixbuf-2.0 fonts-noto-cjk language-pack-ja \
	tint2 feh hsetroot papirus-icon-theme xfce4-terminal pcmanfm mousepad ristretto \
	gstreamer1.0-plugins-base gstreamer1.0-plugins-good gstreamer1.0-plugins-bad gstreamer1.0-plugins-ugly \
	gstreamer1.0-pulseaudio gstreamer1.0-x libxcvt0 \
	libx11-dev libxrandr-dev libxtst-dev libgtk-3-dev libxcvt-dev libgstreamer1.0-dev libgstreamer-plugins-base1.0-dev

GO_ROOT=/opt/go$GO_VERSION
if [[ ! -x $GO_ROOT/bin/go ]]; then
	curl -fsSL "https://go.dev/dl/go$GO_VERSION.linux-amd64.tar.gz" -o "$BUILD/go.tar.gz"
	echo "$GO_SHA256  $BUILD/go.tar.gz" | sha256sum -c -
	install -d "$GO_ROOT"
	tar -C "$GO_ROOT" --strip-components=1 -xzf "$BUILD/go.tar.gz"
fi

install -d -m 0755 "$PREFIX/neko/bin" "$PREFIX/neko/www" "$PREFIX/etc/tint2" "$PREFIX/share/applications"

# 公開イメージは Debian trixie 向けにビルドされていて glibc が合わないため、サーバーはこのホストでビルドする。
mkdir "$BUILD/neko"
curl -fsSL "https://codeload.github.com/m1k1o/neko/tar.gz/$NEKO_COMMIT" | tar -xz -C "$BUILD/neko" --strip-components=1
(
	cd "$BUILD/neko/server"
	PATH=$GO_ROOT/bin:$PATH GOTOOLCHAIN=local GOFLAGS=-mod=readonly GOPATH=$BUILD/gopath GOCACHE=$BUILD/gocache \
		go build -o bin/neko -ldflags "-s -w -X m1k1o/neko.gitCommit=$NEKO_COMMIT -X m1k1o/neko.gitTag=$NEKO_TAG" cmd/neko/main.go
)
install -m 0755 "$BUILD/neko/server/bin/neko" "$PREFIX/neko/bin/neko"

TOKEN=$(curl -fsS "https://ghcr.io/token?scope=repository:$NEKO_WWW_IMAGE:pull" | python3 -c 'import json, sys; print(json.load(sys.stdin)["token"])')
curl -fsSL -H "Authorization: Bearer $TOKEN" "https://ghcr.io/v2/$NEKO_WWW_IMAGE/blobs/$NEKO_WWW_LAYER" -o "$BUILD/www.tar.gz"
echo "${NEKO_WWW_LAYER#sha256:}  $BUILD/www.tar.gz" | sha256sum -c -
mkdir "$BUILD/www"
tar -xzf "$BUILD/www.tar.gz" -C "$BUILD/www"
rm -rf "${PREFIX:?}/neko/www"
cp -a "$BUILD/www/var/www" "$PREFIX/neko/www"
chown -R root:root "$PREFIX"

install -m 0644 "$HERE/session.env" "$HERE/default.pa" "$HERE/neko.yaml" "$HERE/openbox-rc.xml" "$PREFIX/etc/"
install -m 0644 "$HERE"/tint2/*.tint2rc "$PREFIX/etc/tint2/"
install -m 0644 "$HERE"/applications/*.desktop "$PREFIX/share/applications/"
install -m 0644 "$HERE/tmpfiles.conf" /etc/tmpfiles.d/luna-desktop.conf
install -m 0644 "$HERE"/systemd/luna-desktop* /etc/systemd/system/
systemd-tmpfiles --create /etc/tmpfiles.d/luna-desktop.conf

install -d -m 0700 /etc/luna-desktop
if [[ ! -f /etc/luna-desktop/neko.env ]]; then
	(
		umask 077
		printf 'NEKO_WEBRTC_NAT1TO1=%s\nNEKO_MEMBER_MULTIUSER_USER_PASSWORD=%s\nNEKO_MEMBER_MULTIUSER_ADMIN_PASSWORD=%s\n' \
			"$(hostname -I | awk '{print $1}')" "$(openssl rand -hex 12)" "$(openssl rand -hex 12)" >/etc/luna-desktop/neko.env
	)
	echo "created /etc/luna-desktop/neko.env; check NEKO_WEBRTC_NAT1TO1 and read the passwords there"
fi

install -d -o "$LUNA_USER" -g "$LUNA_USER" -m 0700 "$LUNA_HOME/desktop"
SKILL_DIR=$LUNA_HOME/workspace/.agents/skills/luna-desktop
install -d -o "$LUNA_USER" -g "$LUNA_USER" "$SKILL_DIR" "$SKILL_DIR/scripts"
install -o "$LUNA_USER" -g "$LUNA_USER" -m 0644 "$HERE/skill/luna-desktop/SKILL.md" "$SKILL_DIR/"
install -o "$LUNA_USER" -g "$LUNA_USER" -m 0755 "$HERE/skill/luna-desktop/scripts/desktop.py" "$SKILL_DIR/scripts/"
install -o "$LUNA_USER" -g "$LUNA_USER" -m 0644 \
	"$HERE/skill/luna-desktop/scripts/package.json" \
	"$HERE/skill/luna-desktop/scripts/pnpm-lock.yaml" \
	"$HERE/skill/luna-desktop/scripts/pnpm-workspace.yaml" "$SKILL_DIR/scripts/"
su - "$LUNA_USER" -c "pnpm -C '$SKILL_DIR/scripts' install --frozen-lockfile"

systemctl daemon-reload
systemctl enable luna-desktop.target
systemctl restart luna-desktop.target
