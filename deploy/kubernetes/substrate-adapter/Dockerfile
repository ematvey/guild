FROM golang:1.27 AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY *.go ./
RUN CGO_ENABLED=0 go build -trimpath -o /adapter .

FROM scratch
USER 1000:1000
COPY --from=build /adapter /adapter
ENTRYPOINT ["/adapter"]
