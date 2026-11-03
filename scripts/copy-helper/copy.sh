#!/bin/sh
# kesselrunner Copy: puts the text behind a copy link on the clipboard.
#
# The clickable mod saves each code block it draws a copy link for as
# <store>/<id>.txt and links it as kesselrunner-copy://<id>. The helper app hands
# the link it was opened with to this script, which copies that file and prints
# its first line for the notification. Only ids made of [0-9a-z] are read, so a
# link from anywhere else can name nothing outside the store. The set is spelled
# out because a range like 0-9a-z can match more in some locales.
set -eu

url=${1:-}
case $url in
  dotclaude-copy://*) id=${url#dotclaude-copy://} ;; # the scheme before the rename, still drawn by mods loaded earlier
  *) id=${url#kesselrunner-copy://} ;;
esac
id=${id%/}
case $id in
  '' | *[!0123456789abcdefghijklmnopqrstuvwxyz]*) echo "not a copy link: $url" >&2; exit 2 ;;
esac
[ ${#id} -le 64 ] || { echo "not a copy link: $url" >&2; exit 2; }

store=${CLICKABLE_STORE:-$HOME/.claude/clickable/copy}
file=$store/$id.txt
[ -f "$file" ] || { echo "This copy link has expired. Run /copy instead." >&2; exit 3; }

LC_ALL=en_US.UTF-8 pbcopy < "$file"

lines=$(awk 'END { print NR }' "$file")
first=$(head -n 1 "$file" | cut -c 1-80)
if [ "$lines" -gt 1 ]; then echo "$first (+$((lines - 1)) more lines)"; else echo "$first"; fi
