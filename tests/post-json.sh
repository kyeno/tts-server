#!/bin/sh
#
# Helper script to POST a JSON fixture to the TTS server endpoint.
# Usage: ./post-json.sh <fixture-file>
#
# @author Ratan M. Kyeno
# @license MIT
#

curl -X POST \
     -H "Content-Type: application/json" \
     -d @$* \
      http://192.168.1.1:7423/tts
