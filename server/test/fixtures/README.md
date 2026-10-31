`localhost-cert.pem` and `localhost-key.pem` are a throwaway self-signed certificate for `localhost`, made with
`openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -subj /CN=localhost` for the HTTPS test only. They protect nothing.
