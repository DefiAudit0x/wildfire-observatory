export function getDeviceId(): string {
  const sessionId = sessionStorage.getItem("device_id");
  const storedId = localStorage.getItem("device_id");
  let id = sessionId || storedId;
  if (!id) {
    id = `web_${Math.random().toString(36).substring(2, 10)}_${Date.now()}`;
  }
  sessionStorage.setItem("device_id", id);
  localStorage.setItem("device_id", id);
  return id;
}