# RPP connection repair

Goal: make RefreshSideStore discover the actual paired device's RemotePairing service and expose a connection check with useful progress and logs, using the existing Scripting TSX UI and no new dependencies.

Evidence: quick candidate loop only tries preferred/62554/49152; its Bonjour helper is unused and incorrectly expects browse results to contain a port. Bonjour requires resolve. WLOC resolves authenticated advertisements and scans 49152–51200 on fallback. Its pairing stream stays alive through service teardown.

Plan:
- Add regression tests for stale port fallback, resolved Bonjour advertisements, unavailable service errors and resource lifetime before fixes.
- Share connection discovery between both expiry readers: cached/preferred ports, Bonjour.resolve with device IRK authentication, bounded concurrent 49152–51200 fallback. Validate reflected IPv4 and preserve protocol errors separately from TCP reachability.
- Match WLOC host origin/continuous frame sequence and retain the pairing socket through DeviceLink.close; clean up failures and release RSD control slot.
- Add a connection check page with network/VPN/record checks, full RSD handshake/service availability, retry and copy logs. Reuse this same connection path for scans and show scan progress.
- Remove the silent entry's Wi-Fi-only gate; report the actual failure instead of labelling every failure as Wi-Fi.
- Verify node regression suite, strict typecheck using current local App declarations, git diff whitespace and release packaging. iPhone-only native VPN and actual installed profile reads remain a device validation step.

Implementation complete. Regression suite covers stale defaults and advertisements, resolved Bonjour identity, external VPN state conflicts, host framing/continuous counters, pairing lifetime and native timeout cleanup. UI dismissal is disabled during checks to prevent overlapping native opens. Strict whole-project typecheck uses the local App declarations; native iPhone verification remains required.
