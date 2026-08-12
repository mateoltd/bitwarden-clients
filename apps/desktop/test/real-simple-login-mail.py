"""Prove forwarding and reverse-alias delivery for an alias created by Electron."""

from __future__ import annotations

import json
import os
import smtplib
import sys
import time
import urllib.parse
import urllib.request
from email.message import EmailMessage


SMTP_HOST = os.environ.get("SIMPLELOGIN_SMTP_HOST", "127.0.0.1")
SMTP_PORT = int(os.environ.get("SIMPLELOGIN_SMTP_PORT", "20381"))
MAILPIT_URL = os.environ.get("SIMPLELOGIN_MAILPIT_URL", "http://127.0.0.1:18025").rstrip("/")
MAX_BODY = 2_000_000


def mailpit(path: str) -> dict:
    with urllib.request.urlopen(MAILPIT_URL + path, timeout=10) as response:
        encoded = response.read(MAX_BODY + 1)
    if len(encoded) > MAX_BODY:
        raise AssertionError("Mailpit response exceeded the test safety bound")
    return json.loads(encoded)


def wait_for_delivery(subject: str, recipient: str, timeout: float = 45) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        messages = mailpit("/api/v1/messages?limit=200").get("messages", [])
        for message in messages:
            if message.get("Subject") != subject:
                continue
            detail = mailpit(
                "/api/v1/message/" + urllib.parse.quote(str(message["ID"]), safe="")
            )
            if recipient.lower() in json.dumps(detail).lower():
                return
        time.sleep(0.5)
    raise AssertionError(f"Mailpit did not receive {subject!r} for {recipient!r}")


def send(sender: str, recipient: str, subject: str) -> None:
    message = EmailMessage()
    message["From"] = sender
    message["To"] = recipient
    message["Subject"] = subject
    message.set_content(f"Bitwarden real client alias lifecycle: {subject}")
    with smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=10) as smtp:
        smtp.send_message(message, from_addr=sender, to_addrs=[recipient])


def main() -> None:
    if len(sys.argv) != 5:
        raise SystemExit(
            "usage: real-simple-login-mail.py ALIAS MAILBOX CONTACT REVERSE_ALIAS"
        )
    alias, mailbox, contact, reverse_alias = sys.argv[1:]
    nonce = str(time.time_ns())

    inbound_subject = f"bitwarden-electron-inbound-{nonce}"
    send(contact, alias, inbound_subject)
    wait_for_delivery(inbound_subject, mailbox)

    reply_subject = f"bitwarden-electron-reply-{nonce}"
    send(mailbox, reverse_alias, reply_subject)
    wait_for_delivery(reply_subject, contact)

    print("REAL_SIMPLELOGIN_INBOUND_FORWARDED")
    print("REAL_SIMPLELOGIN_REVERSE_ALIAS_REPLY")


if __name__ == "__main__":
    main()
