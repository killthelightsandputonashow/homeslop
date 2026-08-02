const BACKUP_DB_NAME = "homeslop-library";
const BACKUP_DB_VERSION = 1;
const BACKUP_STORE_NAME = "stories";
const BACKUP_FORMAT = "homeslop-backup";
const BACKUP_VERSION = 1;

function openBackupDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(BACKUP_DB_NAME, BACKUP_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(BACKUP_STORE_NAME)) {
        const store = db.createObjectStore(BACKUP_STORE_NAME, { keyPath: "id" });
        store.createIndex("importedAt", "importedAt");
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function readAllStories() {
  const db = await openBackupDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(BACKUP_STORE_NAME, "readonly");
    const request = tx.objectStore(BACKUP_STORE_NAME).getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => db.close();
    tx.onerror = () => reject(tx.error);
  });
}

async function writeStories(stories) {
  const db = await openBackupDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(BACKUP_STORE_NAME, "readwrite");
    const store = tx.objectStore(BACKUP_STORE_NAME);
    stories.forEach((story) => {
      if (story && typeof story === "object" && typeof story.id === "string") store.put(story);
    });
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

function collectHomeslopStorage() {
  const storage = {};
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (!key?.startsWith("homeslop-")) continue;
    storage[key] = localStorage.getItem(key);
  }
  return storage;
}

function restoreHomeslopStorage(storage) {
  if (!storage || typeof storage !== "object") return;
  Object.entries(storage).forEach(([key, value]) => {
    if (!key.startsWith("homeslop-") || typeof value !== "string") return;
    localStorage.setItem(key, value);
  });
}

function backupFilename() {
  const stamp = new Date().toISOString().slice(0, 10);
  return `homeslop-backup-${stamp}.homeslop.json`;
}

async function exportHomeslopBackup(button) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = "PACKING…";

  try {
    const stories = await readAllStories();
    const payload = {
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      exportedAt: new Date().toISOString(),
      stories,
      storage: collectHomeslopStorage(),
    };
    const blob = new Blob([JSON.stringify(payload)], { type: "application/json" });
    const file = new File([blob], backupFilename(), { type: "application/json" });

    if (navigator.canShare?.({ files: [file] }) && navigator.share) {
      await navigator.share({
        files: [file],
        title: "Homeslop backup",
        text: `${stories.length} ${stories.length === 1 ? "story" : "stories"} plus reading progress`,
      });
    } else {
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = file.name;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  } catch (error) {
    if (error?.name !== "AbortError") {
      console.error(error);
      window.alert(`Homeslop could not export the backup: ${error?.message || error}`);
    }
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

async function importHomeslopBackup(file, button) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = "RESTORING…";

  try {
    const payload = JSON.parse(await file.text());
    if (payload?.format !== BACKUP_FORMAT || !Array.isArray(payload.stories)) {
      throw new Error("That file is not a Homeslop backup.");
    }

    const confirmed = window.confirm(
      `Restore ${payload.stories.length} ${payload.stories.length === 1 ? "story" : "stories"} and saved reading progress? Existing stories with the same ID will be updated.`,
    );
    if (!confirmed) return;

    await writeStories(payload.stories);
    restoreHomeslopStorage(payload.storage);
    window.alert("Homeslop backup restored. The library will reload now.");
    window.location.reload();
  } catch (error) {
    console.error(error);
    window.alert(`Homeslop could not restore that backup: ${error?.message || error}`);
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

function installBackupControls() {
  const heading = document.querySelector("#library-view .panel-heading");
  const counter = document.querySelector("#book-count");
  if (!heading || !counter || heading.querySelector(".homeslop-backup-actions")) return;

  const style = document.createElement("style");
  style.textContent = `
    #library-view .panel-heading {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: .65rem;
    }
    .homeslop-backup-actions {
      display: flex;
      gap: .4rem;
      margin-left: auto;
    }
    .homeslop-backup-button {
      min-height: 2rem;
      padding: .35rem .55rem;
      border: 2px outset #aaa;
      color: #111;
      background: #ddd;
      font: 700 .7rem/1 "Courier New", Courier, monospace;
      letter-spacing: .04em;
    }
    .homeslop-backup-button:active { border-style: inset; }
    .homeslop-backup-button:disabled { opacity: .55; }
    @media (max-width: 560px) {
      .homeslop-backup-actions {
        order: 3;
        width: 100%;
        margin-left: 0;
      }
      .homeslop-backup-button { flex: 1; }
    }
  `;
  document.head.append(style);

  const actions = document.createElement("div");
  actions.className = "homeslop-backup-actions";

  const exportButton = document.createElement("button");
  exportButton.className = "homeslop-backup-button";
  exportButton.type = "button";
  exportButton.textContent = "EXPORT BACKUP";

  const importButton = document.createElement("button");
  importButton.className = "homeslop-backup-button";
  importButton.type = "button";
  importButton.textContent = "RESTORE BACKUP";

  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.accept = ".json,.homeslop,application/json";
  fileInput.hidden = true;

  exportButton.addEventListener("click", () => exportHomeslopBackup(exportButton));
  importButton.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", async () => {
    const file = fileInput.files?.[0];
    fileInput.value = "";
    if (file) await importHomeslopBackup(file, importButton);
  });

  actions.append(exportButton, importButton, fileInput);
  heading.insertBefore(actions, counter);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", installBackupControls, { once: true });
} else {
  installBackupControls();
}
