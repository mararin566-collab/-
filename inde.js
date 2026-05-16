/**
 * ผู้ช่วยสื่ออัจฉริยะ - SillyTavern Extension
 * ปลั๊กอินประมวลผลรูปภาพและเอกสารแบบรวม
 * ผู้พัฒนา: ctrl (แปลเป็นภาษาไทยโดย AI ด้วยอนุญาตจากผู้พัฒนา)
 * เวอร์ชัน: 1.5
 */

import { saveSettingsDebounced } from '../../../../script.js';
import { getContext } from '../../../extensions.js';
import { getStringHash, saveBase64AsFile } from '../../../utils.js';

// ค่าคอนฟิกปลั๊กอิน
const PLUGIN_ID = 'smart-media-assistant';
const MODULE_NAME = 'smart-media-assistant';

// ค่าเริ่มต้น
const DEFAULT_CONFIG = {
  enableImageProcessing: true,
  enableDocumentProcessing: true,
  imageQuality: 85,
  maxImageDimension: 2048,
  maxFileSize: 20,
  enableAIReading: true,
  showProcessingInfo: false,
  enableLogging: false,

  // ค่าคอนฟิกภายใน
  supportedImageTypes: ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/bmp'],
  supportedImageExtensions: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'],
  supportedDocumentTypes: [
    'text/plain',
    'application/json',
    'text/markdown',
    'text/csv',
    'text/html',
    'text/xml',
    'application/xml',
    'text/javascript',
    'application/javascript',
    'text/css',
    'application/rtf',
  ],
  supportedDocumentExtensions: [
    'txt',
    'json',
    'md',
    'csv',
    'html',
    'xml',
    'js',
    'css',
    'rtf',
    'log',
    'conf',
    'config',
    'ini',
    'yaml',
    'yml',
  ],
};

// การจัดการค่าคอนฟิกส่วนกลาง
let pluginConfig = {};

/**
 * เริ่มต้นค่าคอนฟิกปลั๊กอิน
 */
function initConfig() {
  const context = typeof getContext === 'function' ? getContext() : null;
  if (!context) {
    throw new Error('[Smart Media Assistant] getContext() ไม่พร้อมใช้งาน: กรุณาตรวจสอบว่ารันอยู่ในสภาพแวดล้อม SillyTavern Extension');
  }
  context.extensionSettings = context.extensionSettings || {};
  const extensionSettings = context.extensionSettings[MODULE_NAME] || {};

  // รวมค่าเริ่มต้นกับค่าที่ผู้ใช้ตั้ง
  pluginConfig = { ...DEFAULT_CONFIG, ...extensionSettings };

  // บันทึกลงการตั้งค่าส่วนกลาง
  context.extensionSettings[MODULE_NAME] = pluginConfig;

  if (pluginConfig.enableLogging) {
    console.log('[Smart Media Assistant] เริ่มต้นค่าคอนฟิกสำเร็จ:', pluginConfig);
  }
}

/**
 * ตัวตรวจจับประเภทไฟล์
 */
class FileTypeDetector {
  static detectFileType(file) {
    if (!file || !file.name) {
      return { type: 'unknown', isImage: false, isDocument: false };
    }

    const fileType = file.type || '';
    const fileName = file.name || '';
    const fileExtension = fileName.split('.').pop()?.toLowerCase() || '';

    // ตรวจจับรูปภาพ
    const isImageByType = pluginConfig.supportedImageTypes.includes(fileType) || fileType.startsWith('image/');
    const isImageByExt = pluginConfig.supportedImageExtensions.includes(fileExtension);
    // บางสภาพแวดล้อม (โดยเฉพาะมือถือ/ลากวาง) อาจไม่ได้ file.type จึงใช้นามสกุลไฟล์แทน
    const isImage = isImageByType || isImageByExt;

    // ตรวจจับเอกสาร
    const isDocumentByType =
      pluginConfig.supportedDocumentTypes.includes(fileType) ||
      fileType.startsWith('text/') ||
      fileType.includes('json') ||
      fileType.includes('xml');
    const isDocumentByExt = pluginConfig.supportedDocumentExtensions.includes(fileExtension);
    const isDocument = isDocumentByType || isDocumentByExt;

    // แก้ความขัดแย้ง: ถ้าตรงทั้งคู่ ให้ใช้นามสกุลไฟล์เป็นหลัก
    let finalType = 'unknown';
    let finalIsImage = false;
    let finalIsDocument = false;

    if (isImage && !isDocument) {
      finalType = 'image';
      finalIsImage = true;
    } else if (isDocument && !isImage) {
      finalType = 'document';
      finalIsDocument = true;
    } else if (isImage && isDocument) {
      // แก้ความขัดแย้ง: ให้นามสกุลไฟล์มีลำดับความสำคัญสูงกว่า
      if (pluginConfig.supportedImageExtensions.includes(fileExtension)) {
        finalType = 'image';
        finalIsImage = true;
      } else {
        finalType = 'document';
        finalIsDocument = true;
      }
    }

    const result = {
      type: finalType,
      isImage: finalIsImage,
      isDocument: finalIsDocument,
      fileType: fileType,
      fileName: fileName,
      fileExtension: fileExtension,
      fileSize: file.size,
    };

    if (pluginConfig.enableLogging) {
      console.log('[File Type Detector] ผลการตรวจจับ:', result);
    }

    return result;
  }
}

/**
 * ตัวตรวจสอบไฟล์
 */
class FileValidator {
  static validate(file, expectedType = null) {
    if (!file || typeof file !== 'object') {
      throw new Error('ออบเจ็กต์ไฟล์ไม่ถูกต้อง');
    }

    const maxBytes = pluginConfig.maxFileSize * 1024 * 1024;
    if (file.size > maxBytes) {
      throw new Error(`ไฟล์ใหญ่เกินไป ขีดจำกัด: ${pluginConfig.maxFileSize}MB`);
    }

    const detection = FileTypeDetector.detectFileType(file);

    if (expectedType === 'image' && !detection.isImage) {
      throw new Error(`รูปแบบรูปภาพที่ไม่รองรับ: ${detection.fileType || 'ไม่ทราบ'} (${file.name})`);
    }

    if (expectedType === 'document' && !detection.isDocument) {
      throw new Error(`รูปแบบเอกสารที่ไม่รองรับ: ${detection.fileType || 'ไม่ทราบ'} (${file.name})`);
    }

    if (!expectedType && detection.type === 'unknown') {
      throw new Error(`ประเภทไฟล์ที่ไม่รองรับ: ${detection.fileType || 'ไม่ทราบ'} (${file.name})`);
    }

    return detection;
  }
}

/**
 * ตัวประมวลผลรูปภาพ
 */
class ImageProcessor {
  static async processImage(file, options = {}) {
    if (!pluginConfig.enableImageProcessing) {
      throw new Error('ฟีเจอร์ประมวลผลรูปภาพถูกปิดใช้งาน');
    }

    const validation = FileValidator.validate(file, 'image');

    if (pluginConfig.showProcessingInfo) {
      toastr.info('กำลังประมวลผลรูปภาพ...', 'อัปโหลดรูปภาพ');
    }

    try {
      // สร้าง element รูปภาพ
      const img = new Image();
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        throw new Error('ไม่สามารถรับ Canvas 2D context ได้');
      }

      const objectUrl = URL.createObjectURL(file);

      return new Promise((resolve, reject) => {
        img.onload = async () => {
          try {
            // คำนวณขนาดใหม่
            let { width, height } = img;
            const maxDim = pluginConfig.maxImageDimension;

            if (width > maxDim || height > maxDim) {
              if (width > height) {
                height = (height * maxDim) / width;
                width = maxDim;
              } else {
                width = (width * maxDim) / height;
                height = maxDim;
              }
            }

            // ตั้งขนาด canvas
            canvas.width = width;
            canvas.height = height;

            // วาดรูปภาพ
            ctx.drawImage(img, 0, 0, width, height);

            // แปลงเป็น base64
            const quality = pluginConfig.imageQuality / 100;
            const imageData = canvas.toDataURL('image/jpeg', quality);
            if (!imageData || !imageData.includes(',')) {
              throw new Error('การเข้ารหัสรูปภาพล้มเหลว');
            }

            // บันทึกไฟล์
            const base64Content = imageData.split(',')[1];
            const fileExtension = 'jpg';
            const uniqueId = `${Date.now()}_${getStringHash(file.name)}`;
            // subfolder under SillyTavern's user images dir: .../user/images/phone/<filename>
            const storagePath = 'phone';

            if (typeof saveBase64AsFile !== 'function') {
              throw new Error('saveBase64AsFile ไม่พร้อมใช้งาน: กรุณาตรวจสอบเวอร์ชัน SillyTavern และ path การโหลด extension');
            }

            const savedUrl = await saveBase64AsFile(base64Content, storagePath, uniqueId, fileExtension);

            const result = {
              success: true,
              url: savedUrl,
              metadata: {
                originalName: file.name,
                processedName: `${uniqueId}.${fileExtension}`,
                originalSize: file.size,
                processedSize: Math.round(base64Content.length * 0.75),
                format: file.type,
                optimized: true,
                timestamp: new Date().toISOString(),
              },
            };

            if (pluginConfig.showProcessingInfo) {
              toastr.success('ประมวลผลรูปภาพเสร็จสิ้น', 'อัปโหลดรูปภาพ');
            }

            resolve(result);
          } catch (error) {
            reject(error);
          } finally {
            // ปลดปล่อย blob URL เพื่อป้องกัน memory leak
            try {
              URL.revokeObjectURL(objectUrl);
            } catch (_) {}
          }
        };

        img.onerror = () => {
          try {
            URL.revokeObjectURL(objectUrl);
          } catch (_) {}
          reject(new Error('โหลดรูปภาพล้มเหลว'));
        };
        img.src = objectUrl;
      });
    } catch (error) {
      if (pluginConfig.showProcessingInfo) {
        toastr.error(`ประมวลผลรูปภาพล้มเหลว: ${error.message}`, 'อัปโหลดรูปภาพ');
      }
      throw error;
    }
  }
}

/**
 * ตัวประมวลผลเอกสาร
 */
class DocumentProcessor {
  static async processDocument(file, options = {}) {
    if (!pluginConfig.enableDocumentProcessing) {
      throw new Error('ฟีเจอร์ประมวลผลเอกสารถูกปิดใช้งาน');
    }

    const validation = FileValidator.validate(file, 'document');

    if (pluginConfig.showProcessingInfo) {
      toastr.info('กำลังประมวลผลเอกสาร...', 'อัปโหลดเอกสาร');
    }

    try {
      // อ่านเนื้อหาเอกสาร
      const content = await DocumentProcessor.readFileContent(file, validation);

      // ประมวลผลเนื้อหา
      const processedContent = DocumentProcessor.processContent(content, validation.fileExtension);

      const result = {
        success: true,
        content: processedContent,
        metadata: {
          originalName: file.name,
          type: file.type || 'text/plain',
          size: file.size,
          documentType: validation.fileExtension,
          contentLength: processedContent.length,
          timestamp: new Date().toISOString(),
        },
      };

      // ถ้าเปิดใช้งาน AI อ่านเอกสาร และต้องการส่งไปยังแชท
      if (pluginConfig.enableAIReading && options.sendToChat !== false) {
        await DocumentProcessor.sendToChat(processedContent, file.name, validation.fileExtension);
      }

      if (pluginConfig.showProcessingInfo) {
        toastr.success('ประมวลผลเอกสารเสร็จสิ้น', 'อัปโหลดเอกสาร');
      }

      return result;
    } catch (error) {
      if (pluginConfig.showProcessingInfo) {
        toastr.error(`ประมวลผลเอกสารล้มเหลว: ${error.message}`, 'อัปโหลดเอกสาร');
      }
      throw error;
    }
  }

  static readFileContent(file, validation) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();

      reader.onload = function (e) {
        try {
          resolve(e.target.result);
        } catch (error) {
          reject(new Error(`อ่านไฟล์ล้มเหลว: ${error.message}`));
        }
      };

      reader.onerror = () => reject(new Error('อ่านไฟล์ล้มเหลว'));
      reader.readAsText(file, 'UTF-8');
    });
  }

  static processContent(content, fileExtension) {
    switch (fileExtension) {
      case 'json':
        try {
          const jsonObj = JSON.parse(content);
          return JSON.stringify(jsonObj, null, 2);
        } catch (error) {
          console.warn('[Document Processor] จัดรูปแบบ JSON ล้มเหลว คืนค่าเนื้อหาเดิม');
          return content;
        }

      case 'csv':
        // ประมวลผลตัวอย่าง CSV
        const lines = content.split('\n');
        const maxPreviewLines = 50;
        if (lines.length > maxPreviewLines) {
          const previewLines = lines.slice(0, maxPreviewLines);
          return previewLines.join('\n') + `\n\n... (ไฟล์มีทั้งหมด ${lines.length} บรรทัด แสดงเฉพาะ ${maxPreviewLines} บรรทัดแรก)`;
        }
        return content;

      default:
        return content;
    }
  }

  static async sendToChat(content, fileName, documentType) {
    try {
      // ดึงฟังก์ชันแชทของ SillyTavern
      const addOneMessage =
        typeof window.addOneMessage === 'function'
          ? window.addOneMessage
          : typeof parent.addOneMessage === 'function'
            ? parent.addOneMessage
            : typeof top.addOneMessage === 'function'
              ? top.addOneMessage
              : null;

      if (addOneMessage) {
        // จำกัดความยาวที่แสดง
        const maxLength = 2000;
        const displayContent =
          content.length > maxLength ? content.substring(0, maxLength) + '\n\n...(เนื้อหาถูกตัดทอน)' : content;

        // ไอคอนประเภทเอกสาร
        const typeIcons = {
          json: '📋',
          md: '📝',
          html: '🌐',
          xml: '📄',
          csv: '📊',
          js: '⚡',
          css: '🎨',
          yaml: '⚙️',
          yml: '⚙️',
          log: '📜',
        };

        const icon = typeIcons[documentType] || '📄';
        const messageContent = `${icon} **เนื้อหาเอกสาร** (${fileName})\n\n\`\`\`${documentType}\n${displayContent}\n\`\`\``;

        await addOneMessage({
          name: 'User',
          is_user: true,
          is_system: false,
          send_date: new Date().toISOString(),
          mes: messageContent,
          extra: {
            type: 'document_upload',
            file_name: fileName,
            document_type: documentType,
            processed_by: 'smart_media_assistant',
          },
        });

        if (pluginConfig.enableLogging) {
          console.log('[Document Processor] ส่งเอกสารไปยังแชทแล้ว');
        }
      } else {
        // Fallback: บางเวอร์ชัน/วิธีฝัง addOneMessage อาจไม่อยู่บน window ให้ลองใช้ slash /send
        try {
          await processTextBridge(content, { name: fileName });
        } catch (_) {}
      }
    } catch (error) {
      console.error('[Document Processor] ส่งเอกสารล้มเหลว:', error);
    }
  }
}

/**
 * อินเทอร์เฟซประมวลผลไฟล์หลัก
 */
class FileProcessor {
  static async processFile(file, options = {}) {
    try {
      if (!file) {
        throw new Error('กรุณาระบุไฟล์');
      }

      const detection = FileTypeDetector.detectFileType(file);

      if (pluginConfig.enableLogging) {
        console.log('[File Processor] กำลังประมวลผลไฟล์:', {
          name: file.name,
          type: file.type,
          size: file.size,
          detection: detection,
        });
      }

      // เลือกตัวประมวลผลตามผลการตรวจจับ
      if (detection.isImage) {
        if (pluginConfig.enableLogging) {
          console.log('[File Processor] ใช้ตัวประมวลผลรูปภาพ');
        }
        return await ImageProcessor.processImage(file, options);
      } else if (detection.isDocument) {
        if (pluginConfig.enableLogging) {
          console.log('[File Processor] ใช้ตัวประมวลผลเอกสาร');
        }
        return await DocumentProcessor.processDocument(file, options);
      } else {
        throw new Error(`ประเภทไฟล์ที่ไม่รองรับ: ${detection.fileType || 'ไม่ทราบ'} (${file.name})`);
      }
    } catch (error) {
      console.error('[File Processor] ประมวลผลล้มเหลว:', error);
      throw error;
    }
  }
}

// ==================== ส่วน API ภายนอก ====================

/**
 * อินเทอร์เฟซประมวลผลไฟล์ทั่วไป
 */
window.__processFileByPlugin = async function (file, options = {}) {
  return await FileProcessor.processFile(file, options);
};

/**
 * อินเทอร์เฟซประมวลผลรูปภาพ (รองรับภาพเดียวและหลายภาพ)
 */
window.__uploadImageByPlugin = async function (file, options = {}) {
  return await ImageProcessor.processImage(file, options);
};

/**
 * อินเทอร์เฟซประมวลผลหลายภาพพร้อมกัน
 */
window.__uploadMultipleImagesByPlugin = async function (files, options = {}) {
  console.log(`🖼️ ปลั๊กอินเริ่มประมวลผลแบบกลุ่ม ${files.length} รูป`);

  const results = [];
  const errors = [];

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    try {
      console.log(`🖼️ กำลังประมวลผลรูปที่ ${i + 1}/${files.length}: ${file.name}`);
      const result = await ImageProcessor.processImage(file, options);

      // เพิ่มข้อมูล index ให้กับผลลัพธ์หลายภาพ
      result.multiImageIndex = i + 1;
      result.multiImageTotal = files.length;
      result.originalFileName = file.name;

      results.push(result);
      console.log(`✅ ประมวลผลรูปที่ ${i + 1} เสร็จสิ้น`);
    } catch (error) {
      console.error(`❌ ประมวลผลรูปที่ ${i + 1} ล้มเหลว:`, error);
      errors.push({
        index: i + 1,
        fileName: file.name,
        error: error.message,
      });
    }
  }

  console.log(`🖼️ ประมวลผลกลุ่มเสร็จสิ้น: สำเร็จ ${results.length} รูป, ล้มเหลว ${errors.length} รูป`);

  return {
    success: results.length > 0,
    results: results,
    errors: errors,
    totalCount: files.length,
    successCount: results.length,
    errorCount: errors.length,
  };
};

/**
 * อินเทอร์เฟซประมวลผลเอกสาร
 */
window.__processDocumentByPlugin = async function (file, options = {}) {
  return await DocumentProcessor.processDocument(file, options);
};

/**
 * อินเทอร์เฟซตรวจจับประเภทไฟล์
 */
window.__isDocumentFile = function (file) {
  const detection = FileTypeDetector.detectFileType(file);
  return detection.isDocument;
};

/**
 * ดึงประเภทไฟล์ที่รองรับ
 */
window.__getSupportedFileTypes = function () {
  return {
    images: pluginConfig.supportedImageTypes,
    documents: pluginConfig.supportedDocumentTypes,
    imageExtensions: pluginConfig.supportedImageExtensions,
    documentExtensions: pluginConfig.supportedDocumentExtensions,
    all: function () {
      return [...this.images, ...this.documents];
    },
  };
};

// ==================== วงจรชีวิตปลั๊กอิน ====================

/**
 * เริ่มต้นปลั๊กอิน
 */
function initPlugin() {
  console.log('[Smart Media Assistant] เริ่มต้นปลั๊กอิน...');

  // เริ่มต้นค่าคอนฟิก
  initConfig();

  // เพิ่ม style
  addPluginStyles();

  // สร้างหน้าการตั้งค่า
  createSettingsInterface();

  // ผูก event listener
  bindEventListeners();

  // ผูกฟังก์ชัน collapsible
  bindCollapsibleEvents();

  console.log('[Smart Media Assistant] เริ่มต้นปลั๊กอินเสร็จสิ้น');

  // แสดงการแจ้งเตือนโหลดสำเร็จ
  if (pluginConfig.showProcessingInfo) {
    toastr.success('โหลดผู้ช่วยสื่ออัจฉริยะเสร็จแล้ว', 'สถานะปลั๊กอิน');
  }
}

/**
 * สร้างหน้าการตั้งค่า
 */
function createSettingsInterface() {
  // ตรวจสอบว่ามีหน้าการตั้งค่าอยู่แล้วหรือไม่
  if ($('#smart-media-assistant-settings').length > 0) {
    return;
  }

  // สร้าง HTML การตั้งค่า
  const settingsHTML = createSettingsHTML();

  // เพิ่มลงในหน้าการตั้งค่า extension
  const extensionsSettings = $('#extensions_settings');
  if (extensionsSettings.length > 0) {
    extensionsSettings.append(`<div id="smart-media-assistant-settings">${settingsHTML}</div>`);

    if (pluginConfig.enableLogging) {
      console.log('[Smart Media Assistant] สร้างหน้าการตั้งค่าแล้ว');
    }
  } else {
    console.warn('[Smart Media Assistant] ไม่พบ container การตั้งค่า extension');
  }
}

/**
 * เพิ่ม style ปลั๊กอิน
 */
function addPluginStyles() {
  // ปรับให้เข้ากับรูปลักษณ์ SillyTavern: ใช้ style ในตัวให้มากที่สุด ปรับแต่งเล็กน้อย
  const styleId = 'smart-media-assistant-dynamic-styles';
  if (document.getElementById(styleId)) return;

  const style = document.createElement('style');
  style.id = styleId;
  style.textContent = `
    /* ปรับ layout เล็กน้อยเท่านั้น เพื่อให้เข้ากับ style โดยรวม */
    #smart-media-assistant-settings .settings-title-text { font-weight: 600; }
    #smart-media-assistant-settings .inline-drawer { margin-top: 6px; }
    #smart-media-assistant-settings .box-container { align-items: center; }
    #smart-media-assistant-settings .box-container .flex.flexFlowColumn { gap: 2px; }
    #smart-media-assistant-settings .range-row { display: grid; grid-template-columns: 1fr auto; gap: 8px; align-items: center; }
    #smart-media-assistant-settings .range-row input[type="range"] { width: 100%; }
  `;
  document.head.appendChild(style);
}

/**
 * สร้างหน้าการตั้งค่าHTML
 */
function createSettingsHTML() {
  // ใช้โครงสร้างรูปลักษณ์ของ SillyTavern/JS-Slash-Runner
  return `
    <div id="smart-media-assistant" class="extension-root">
      <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
          <b>ปลั๊กอินอ่านภาพ byctrl</b>
          <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">
          <div class="extension-content flex flexFlowColumn gap10px">

            <div class="extension-content-item box-container">
              <div class="flex flexFlowColumn">
                <div class="settings-title-text">เปิดใช้งานประมวลผลรูปภาพ</div>
                <div class="settings-title-description">เปิดการบีบอัด, ปรับปรุง และ AI อ่านรูปภาพ</div>
              </div>
              <div class="toggle-switch">
                <input type="checkbox" id="${MODULE_NAME}_enableImageProcessing" class="toggle-input" ${pluginConfig.enableImageProcessing ? 'checked' : ''} />
                <label for="${MODULE_NAME}_enableImageProcessing" class="toggle-label"><span class="toggle-handle"></span></label>
              </div>
            </div>

            <div class="extension-content-item box-container">
              <div class="flex flexFlowColumn">
                <div class="settings-title-text">เปิดใช้งานประมวลผลเอกสาร</div>
                <div class="settings-title-description">รองรับไฟล์ข้อความ txt/json/md/csv และอื่นๆ</div>
              </div>
              <div class="toggle-switch">
                <input type="checkbox" id="${MODULE_NAME}_enableDocumentProcessing" class="toggle-input" ${pluginConfig.enableDocumentProcessing ? 'checked' : ''} />
                <label for="${MODULE_NAME}_enableDocumentProcessing" class="toggle-label"><span class="toggle-handle"></span></label>
              </div>
            </div>

            <div class="extension-content-item box-container">
              <div class="flex flexFlowColumn">
                <div class="settings-title-text">เปิดใช้งาน AI อ่านเอกสาร</div>
                <div class="settings-title-description">ส่งไปยังแชทอัตโนมัติหลังอัปโหลดและเรียกการสร้าง</div>
              </div>
              <div class="toggle-switch">
                <input type="checkbox" id="${MODULE_NAME}_enableAIReading" class="toggle-input" ${pluginConfig.enableAIReading ? 'checked' : ''} />
                <label for="${MODULE_NAME}_enableAIReading" class="toggle-label"><span class="toggle-handle"></span></label>
              </div>
            </div>

            <div class="extension-content-item box-container">
              <div class="flex flexFlowColumn">
                <div class="settings-title-text">คุณภาพรูปภาพ <span id="${MODULE_NAME}_imageQualityValue">${pluginConfig.imageQuality}</span>%</div>
                <div class="range-row">
                  <input type="range" id="${MODULE_NAME}_imageQuality" min="10" max="100" step="5" value="${pluginConfig.imageQuality}">
                </div>
                <div class="settings-title-description">ค่ายิ่งสูงคุณภาพยิ่งดี แต่ไฟล์ยิ่งใหญ่</div>
              </div>
            </div>

            <div class="extension-content-item box-container">
              <div class="flex flexFlowColumn">
                <div class="settings-title-text">ขนาดสูงสุดของรูปภาพ <span id="${MODULE_NAME}_maxImageDimensionValue">${pluginConfig.maxImageDimension}</span>px</div>
                <div class="range-row">
                  <input type="range" id="${MODULE_NAME}_maxImageDimension" min="512" max="4096" step="128" value="${pluginConfig.maxImageDimension}">
                </div>
                <div class="settings-title-description">ความกว้างหรือความสูงสูงสุดของรูปภาพ (พิกเซล)</div>
              </div>
            </div>

            <div class="extension-content-item box-container">
              <div class="flex flexFlowColumn">
                <div class="settings-title-text">จำกัดขนาดไฟล์ <span id="${MODULE_NAME}_maxFileSizeValue">${pluginConfig.maxFileSize}</span>MB</div>
                <div class="range-row">
                  <input type="range" id="${MODULE_NAME}_maxFileSize" min="1" max="100" step="1" value="${pluginConfig.maxFileSize}">
                </div>
                <div class="settings-title-description">ขนาดไฟล์สูงสุดที่ประมวลผลได้</div>
              </div>
            </div>

            <div class="extension-content-item box-container">
              <div class="flex flexFlowColumn">
                <div class="settings-title-text">แสดงข้อมูลการประมวลผล</div>
                <div class="settings-title-description">แสดงความคืบหน้าและการแจ้งเตือนการประมวลผล</div>
              </div>
              <div class="toggle-switch">
                <input type="checkbox" id="${MODULE_NAME}_showProcessingInfo" class="toggle-input" ${pluginConfig.showProcessingInfo ? 'checked' : ''} />
                <label for="${MODULE_NAME}_showProcessingInfo" class="toggle-label"><span class="toggle-handle"></span></label>
              </div>
            </div>

            <div class="extension-content-item box-container">
              <div class="flex flexFlowColumn">
                <div class="settings-title-text">บันทึก Debug</div>
                <div class="settings-title-description">แสดงข้อมูลเพิ่มเติมใน console</div>
              </div>
              <div class="toggle-switch">
                <input type="checkbox" id="${MODULE_NAME}_enableLogging" class="toggle-input" ${pluginConfig.enableLogging ? 'checked' : ''} />
                <label for="${MODULE_NAME}_enableLogging" class="toggle-label"><span class="toggle-handle"></span></label>
              </div>
            </div>

          </div>
        </div>
      </div>
    </div>
  `;
}

/**
 * ผูก event แถบพับ
 */
function bindCollapsibleEvents() {
  const STORAGE_KEY = 'smart-media-assistant-collapsed';

  const $root = $('#smart-media-assistant-settings .inline-drawer');
  const $toggle = $root.find('.inline-drawer-toggle');
  const $content = $root.find('.inline-drawer-content');
  const $icon = $root.find('.inline-drawer-icon');
  if ($root.length === 0 || $toggle.length === 0) {
    return;
  }

  // Debounce: ป้องกันการคลิกเดียวกันถูกเรียกซ้ำในช่วง bubbling โดย handler อื่น
  let toggleLock = false;

  function setCollapsed(collapsed) {
    if (collapsed) {
      $content.hide();
      $icon.removeClass('down').addClass('right');
    } else {
      $content.show();
      $icon.removeClass('right').addClass('down');
    }
    $toggle.attr('aria-expanded', (!collapsed).toString());
    localStorage.setItem(STORAGE_KEY, collapsed ? 'true' : 'false');
  }

  // สถานะเริ่มต้น
  const collapsed = localStorage.getItem(STORAGE_KEY) === 'true';
  setCollapsed(collapsed);

  // สลับเมื่อคลิก (ใช้ mousedown และหยุด bubbling เพื่อป้องกันการยุบทันทีจาก logic ภายนอก)
  $toggle
    .off('.sma')
    .attr('role', 'button')
    .attr('tabindex', '0')
    .on('mousedown.sma', function (e) {
      // หยุดเหตุการณ์ไม่ให้ bubbling ไปยัง global click listener เพื่อป้องกันการปิดทันที
      e.preventDefault();
      e.stopPropagation();
      if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();

      if (toggleLock) return; // Debounce
      toggleLock = true;

      const willCollapse = $content.is(':visible');
      setCollapsed(willCollapse);
      if (pluginConfig.enableLogging) {
        console.log(`[Smart Media Assistant] แผงการตั้งค่า${willCollapse ? 'ยุบ' : 'ขยาย'}แล้ว`);
      }

      // ปลดล็อกชั่วคราว เพื่อป้องกัน listener อื่นในขั้นตอนคลิกเดียวกันทำงานซ้ำ
      setTimeout(() => (toggleLock = false), 200);
    })
    .on('click.sma', function (e) {
      e.preventDefault();
      e.stopPropagation();
      if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
    })
    .on('keydown.sma', function (e) {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      e.stopPropagation();
      if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
      $(this).trigger('mousedown');
    });
}

/**
 * ผูก event listener
 */
function bindEventListeners() {
  // ฟังการเปลี่ยนแปลงการตั้งค่า
  $(document).on('change', `#${MODULE_NAME}_enableImageProcessing`, function () {
    pluginConfig.enableImageProcessing = $(this).prop('checked');
    saveSettings();
  });

  $(document).on('change', `#${MODULE_NAME}_enableDocumentProcessing`, function () {
    pluginConfig.enableDocumentProcessing = $(this).prop('checked');
    saveSettings();
  });

  $(document).on('input', `#${MODULE_NAME}_imageQuality`, function () {
    const value = parseInt($(this).val());
    pluginConfig.imageQuality = value;
    $(`#${MODULE_NAME}_imageQualityValue`).text(value);
    saveSettings();
  });

  $(document).on('input', `#${MODULE_NAME}_maxImageDimension`, function () {
    const value = parseInt($(this).val());
    pluginConfig.maxImageDimension = value;
    $(`#${MODULE_NAME}_maxImageDimensionValue`).text(value);
    saveSettings();
  });

  $(document).on('input', `#${MODULE_NAME}_maxFileSize`, function () {
    const value = parseInt($(this).val());
    pluginConfig.maxFileSize = value;
    $(`#${MODULE_NAME}_maxFileSizeValue`).text(value);
    saveSettings();
  });

  $(document).on('change', `#${MODULE_NAME}_enableAIReading`, function () {
    pluginConfig.enableAIReading = $(this).prop('checked');
    saveSettings();
  });

  $(document).on('change', `#${MODULE_NAME}_showProcessingInfo`, function () {
    pluginConfig.showProcessingInfo = $(this).prop('checked');
    saveSettings();
  });

  $(document).on('change', `#${MODULE_NAME}_enableLogging`, function () {
    pluginConfig.enableLogging = $(this).prop('checked');
    saveSettings();
  });
}

/**
 * บันทึกการตั้งค่า
 */
function saveSettings() {
  const context = typeof getContext === 'function' ? getContext() : null;
  if (!context) return;
  context.extensionSettings = context.extensionSettings || {};
  context.extensionSettings[MODULE_NAME] = pluginConfig;
  saveSettingsDebounced();

  if (pluginConfig.enableLogging) {
    console.log('[Smart Media Assistant] บันทึกการตั้งค่าแล้ว:', pluginConfig);
  }
}

// ==================== จุดเริ่มต้นปลั๊กอิน ====================

// jQuery ready
$(document).ready(function () {
  initPlugin();
});

// Export module (ถ้าจำเป็น)
// Smart Media Assistant: minimal global bridge
function sanitizeForSlash(text) {
  if (!text) return '';
  return String(text).replaceAll('|', '¦');
}
async function loadSlashCommandsModule() {
  const candidates = [
    '/scripts/slash-commands.js',
    '../../scripts/slash-commands.js',
    '../../../scripts/slash-commands.js',
    '../../../../scripts/slash-commands.js',
  ];
  for (const p of candidates) {
    try {
      const mod = await import(p);
      if (mod && typeof mod.executeSlashCommandsWithOptions === 'function') {
        return mod;
      }
    } catch (e) {}
  }
  return null;
}
async function sendTextToSillyTavern(content) {
  const cmd = `/send ${content} | /trigger`;
  try {
    const mod = await loadSlashCommandsModule();
    if (mod && typeof mod.executeSlashCommandsWithOptions === 'function') {
      await mod.executeSlashCommandsWithOptions(cmd, {
        handleParserErrors: true,
        handleExecutionErrors: true,
        source: MODULE_NAME,
      });
      return true;
    }
  } catch (e) {}
  try {
    if (typeof window.triggerSlash === 'function') {
      window.triggerSlash(cmd);
      return true;
    }
  } catch (e) {}
  console.warn('[Smart Media Assistant] ไม่พบ slash-commands หรือ triggerSlash ส่งไม่สำเร็จ');
  return false;
}
async function processTextBridge(text, options = {}) {
  const name = options?.name || 'ข้อความ';
  const header = options?.prompt || `กรุณาอ่านและสรุปข้อมูลสำคัญจากไฟล์ ${name} ต่อไปนี้:`;
  const safe = sanitizeForSlash(text);
  const content = `${header}\n\n${safe}`;
  if (pluginConfig.enableLogging) {
    console.log('[Smart Media Assistant] ส่งเอกสารไปยัง SillyTavern เพื่อสร้างสรุป', { name, size: options?.size });
  }
  return await sendTextToSillyTavern(content);
}
function exposeGlobalBridge() {
  try {
    const target = typeof window !== 'undefined' ? window : globalThis;
    target.smartMediaAssistant = target.smartMediaAssistant || {};
    if (typeof target.smartMediaAssistant.processText !== 'function') {
      target.smartMediaAssistant.processText = (text, options) => processTextBridge(text, options);
      if (pluginConfig.enableLogging) {
        console.log('[Smart Media Assistant] เปิดเผย bridge แล้ว: smartMediaAssistant.processText');
      }
    }
  } catch (e) {
    console.warn('[Smart Media Assistant] เปิดเผย global bridge ล้มเหลว', e);
  }
}
try {
  exposeGlobalBridge();
} catch (e) {}
export { DocumentProcessor, FileProcessor, FileTypeDetector, FileValidator, ImageProcessor };
