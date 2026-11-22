FROM clamav/clamav:1.5.4@sha256:bda39705e291105049c3936e2803ac90b955172af8030f94f05dce1252df6c6d

LABEL org.opencontainers.image.source="https://github.com/marabi766/RASTA" \
      org.opencontainers.image.description="ClamAV 1.5.4 with the Alpine 3.24 libxml2 security update"

# The CI runtime uses linux/amd64. Verify the Alpine package digest and let
# apk verify its signature with the trusted keys inherited from the base.
RUN wget -q -O /tmp/libxml2-2.13.9-r3.apk \
        https://dl-cdn.alpinelinux.org/alpine/v3.24/main/x86_64/libxml2-2.13.9-r3.apk \
    && echo '8b37229c4761cf0eef5089045283526ef43bf335073050515010d34a313186ed  /tmp/libxml2-2.13.9-r3.apk' | sha256sum -c - \
    && apk add --no-network /tmp/libxml2-2.13.9-r3.apk \
    && rm /tmp/libxml2-2.13.9-r3.apk
