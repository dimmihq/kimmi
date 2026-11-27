# Dashboard and SDK. Built once on the build machine's own architecture:
# the output is plain files.
FROM --platform=$BUILDPLATFORM node:24-alpine AS web
WORKDIR /src
RUN corepack enable
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY web/package.json web/
COPY sdk/browser/package.json sdk/browser/
RUN pnpm install --frozen-lockfile --filter @kimmi/web... --filter @kimmi/browser...
COPY web web
COPY sdk/browser sdk/browser
RUN pnpm --filter @kimmi/browser build && pnpm --filter @kimmi/web build

# Server, cross-compiled for the target architecture.
FROM --platform=$BUILDPLATFORM golang:1.26-alpine AS server
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY cmd cmd
COPY internal internal
COPY --from=web /src/web/dist internal/webui/dist
COPY --from=web /src/sdk/browser/dist/kimmi.js internal/webui/dist/kimmi.js
ARG TARGETOS=linux
ARG TARGETARCH
ARG VERSION=dev
ARG COMMIT=none
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build -trimpath \
    -ldflags "-s -w -X main.version=${VERSION} -X main.commit=${COMMIT}" \
    -o /out/kimmi ./cmd/kimmi

FROM alpine:3.22
RUN adduser -D -u 10001 kimmi && mkdir /data && chown kimmi /data
USER 10001
WORKDIR /data
COPY --from=server /out/kimmi /usr/local/bin/kimmi
EXPOSE 8700
ENTRYPOINT ["kimmi"]
CMD ["serve"]
