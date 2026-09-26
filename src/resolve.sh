#!/bin/bash
# Pass a result through to Alfred's clipboard object.
# Large results arrive as "wcfile:<path>" (written by webcapture.js to the workflow cache).
case "$1" in
  wcfile:*)
    f="${1#wcfile:}"
    case "$f" in
      *"/../"*) ;;
      "$alfred_workflow_cache"/*) [ -f "$f" ] && cat "$f" ;;
      *) printf '%s' "$1" ;;
    esac ;;
  *) printf '%s' "$1" ;;
esac
