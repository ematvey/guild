FROM golang:1.27 AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY main.go ./
RUN CGO_ENABLED=0 go build -trimpath -o /workspace-csi .

FROM scratch
COPY --from=build /workspace-csi /workspace-csi
ENTRYPOINT ["/workspace-csi"]
