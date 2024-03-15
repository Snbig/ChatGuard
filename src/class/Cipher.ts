import forge from "node-forge";
import { config } from "src/config";
import BrowserStorage from "src/utils/BrowserStorage";
import LocalStorage from "src/utils/LocalStorage";
import logger from "src/utils/logger";

export class Cipher {
  public async createDRSAP(message: string, to: string) {
    if (message.trim() === "") return "";

    let store = await BrowserStorage.get();
    const secretKey = forge.random.getBytesSync(16);
    const hexSecret = forge.util.bytesToHex(secretKey);

    const ownPublicKey = forge.pki.publicKeyFromPem(store.user!.publicKey);
    const { publicKey: publicKeyPem } = LocalStorage.getMap(config.CONTACTS_STORAGE_KEY, to);
    if (!publicKeyPem) return null;
    const toPublicKey = forge.pki.publicKeyFromPem(publicKeyPem);
    const r1 = forge.util.bytesToHex(ownPublicKey.encrypt(secretKey));
    const r2 = forge.util.bytesToHex(toPublicKey.encrypt(secretKey));
    const encryptedMessage = await this.encryptAES(message, hexSecret);
    const template = config.ENCRYPT_PREFIX + r1 + r2 + encryptedMessage;
    return template;
  }
  public async resolveDRSAP(packet: string) {
    let store = await BrowserStorage.get();
    const packetArray = packet.split(config.ENCRYPT_PREFIX)[1].split("");
    const r1 = packetArray.splice(0, 128).join("");
    const r2 = packetArray.splice(0, 128).join("");

    const ownPrivateKey = forge.pki.privateKeyFromPem(store.user!.privateKey);
    let key;
    try {
      key = ownPrivateKey.decrypt(forge.util.hexToBytes(r1));
    } catch (error) {}
    if (!key) {
      try {
        key = ownPrivateKey.decrypt(forge.util.hexToBytes(r2));
      } catch (error) {}
    }
    if (!key) return null;
    const message = this.decryptAES(packetArray.join(""), forge.util.bytesToHex(key));
    return message;
  }

  public async createDRSAPHandshake(to: string) {
    const store = await BrowserStorage.get();
    const cleanedPublicKey = store.user!.publicKey.replace(/[\r\n]/g, "");
    const packet = `${config.HANDSHAKE_PREFIX}__${new Date().getTime()}__${to}__${cleanedPublicKey}`;
    return packet;
  }
  public async resolveDRSAPHandshake(packet: string, from: string) {
    const [_prefix, timestamp, toId, publicKey] = packet.split("__");
    if (toId === from) return;
    const oldContact = LocalStorage.getMap(config.CONTACTS_STORAGE_KEY, from);
    if (+timestamp < +(oldContact.timestamp || 0)) return logger.debug(`Handshake ${toId} is old`);
    const allHandshakes = LocalStorage.get(config.CONTACTS_STORAGE_KEY);
    let isFound = false;
    for (let handshake in allHandshakes) {
      if (publicKey === allHandshakes[handshake].publicKey) isFound = true;
    }
    if (isFound) {
      LocalStorage.setMap(config.CONTACTS_STORAGE_KEY, from, {
        ...oldContact,
        acknowledged: true,
      });
      logger.info(`Already have Handshake ${toId}`);
      return;
    }

    LocalStorage.setMap(config.CONTACTS_STORAGE_KEY, from, {
      publicKey,
      timestamp,
      enable: true,
    });
    logger.info(`New Handshake ${toId} registered`);
    return this.createDRSAPAcknowledgment(from);
  }
  public createDRSAPAcknowledgment(toId: string) {
    return `${config.ACKNOWLEDGMENT_PREFIX}__${toId}`;
  }
  public resolveDRSAPAcknowledgment(packet: string, from: string) {
    const [_, id] = packet.split("__");
    if (from === id) return;

    const user = LocalStorage.getMap(config.CONTACTS_STORAGE_KEY, from);
    if (!user.publicKey) return;
    user.acknowledged = true;
    logger.info(`Acknowledgment for ${id} Handshake`);
    LocalStorage.setMap(config.CONTACTS_STORAGE_KEY, from, user);
  }
  public static validatePublicPem(pem: string) {
    try {
      forge.pki.publicKeyFromPem(pem);
      return true;
    } catch (error) {
      return false;
    }
  }
  public static validatePrivatePem(pem: string) {
    try {
      forge.pki.privateKeyFromPem(pem);
      return true;
    } catch (error) {
      return false;
    }
  }
  public async encryptAES(message: string, secretKey: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(message);

    const cryptoKey = await window.crypto.subtle.importKey(
      "raw",
      encoder.encode(secretKey),
      { name: "AES-CBC" },
      false,
      ["encrypt"],
    );

    const iv = window.crypto.getRandomValues(new Uint8Array(16));

    const encryptedData = await window.crypto.subtle.encrypt({ name: "AES-CBC", iv: iv }, cryptoKey, data);

    const encryptedMessage = new Uint8Array(iv.length + encryptedData.byteLength);
    encryptedMessage.set(iv);
    encryptedMessage.set(new Uint8Array(encryptedData), iv.length);

    return Array.from(encryptedMessage)
      .map((byte) => ("0" + (byte & 0xff).toString(16)).slice(-2))
      .join("");
  }

  public async decryptAES(encryptedMessage: string, secretKey: string): Promise<string> {
    const decoder = new TextDecoder();
    const encryptedData = new Uint8Array(encryptedMessage.match(/[\da-f]{2}/gi)!.map((hex) => parseInt(hex, 16)));

    const iv = encryptedData.slice(0, 16);

    const cryptoKey = await window.crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secretKey),
      { name: "AES-CBC" },
      false,
      ["decrypt"],
    );

    const decryptedData = await window.crypto.subtle.decrypt(
      { name: "AES-CBC", iv: iv },
      cryptoKey,
      encryptedData.slice(16),
    );

    return decoder.decode(decryptedData);
  }

  static async generateKeyPair() {
    const keyPair = await forge.pki.rsa.generateKeyPair({ bits: 512, workers: 2 });
    const publicKey = forge.pki.publicKeyToPem(keyPair.publicKey);
    const privateKey = forge.pki.privateKeyToPem(keyPair.privateKey);

    return { privateKey, publicKey };
  }
}
export default Cipher;
