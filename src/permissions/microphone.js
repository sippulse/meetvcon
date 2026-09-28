// One-time microphone grant for the extension origin. The offscreen recorder
// reuses this grant; it cannot prompt on its own.

const allow = document.getElementById("allow");
const message = document.getElementById("message");

async function requestMicrophone() {
  allow.disabled = true;
  message.textContent = "Requesting microphone access…";
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    stream.getTracks().forEach((track) => track.stop());
    message.textContent = "Microphone access granted. You can close this tab.";
    allow.hidden = true;
  } catch (error) {
    message.textContent =
      error.name === "NotAllowedError"
        ? "Access was blocked. Click the camera/microphone icon in the address bar to allow it, then try again."
        : `Microphone unavailable: ${error.message}`;
    allow.disabled = false;
  }
}

async function currentState() {
  try {
    const status = await navigator.permissions.query({ name: "microphone" });
    return status.state;
  } catch {
    return "prompt";
  }
}

allow.addEventListener("click", requestMicrophone);

currentState().then((state) => {
  if (state === "granted") {
    message.textContent = "Microphone access is already granted. You can close this tab.";
    allow.hidden = true;
  } else {
    requestMicrophone();
  }
});
