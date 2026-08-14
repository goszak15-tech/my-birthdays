/* ==========================================================================
   sw.js — Service Worker приложения "Дни рождения"
   --------------------------------------------------------------------------
   Задача этого файла: работать в фоне (даже когда сайт закрыт) и раз в сутки
   проверять список людей — если у кого-то сегодня день рождения, показать
   обычное системное уведомление на экране телефона.

   ВАЖНО (техническое ограничение браузеров):
   У Service Worker'а НЕТ доступа к localStorage — это API работает только
   внутри обычной открытой страницы. Поэтому мы храним собственную копию
   списка людей в IndexedDB (это хранилище, в отличие от localStorage,
   доступно и из фонового Service Worker'а). Страница (index.html) должна
   при каждом изменении списка отправлять сюда свежие данные через
   postMessage — сообщение с type: 'SYNC_PEOPLE' (см. обработчик 'message'
   ниже). Без этого шага в index.html Service Worker будет "не в курсе"
   списка людей.
   ========================================================================== */

const DB_NAME = 'birthdayAppSW';       // имя базы IndexedDB внутри Service Worker'а
const STORE_NAME = 'people';           // название "хранилища" в базе
const PERIODIC_SYNC_TAG = 'check-birthdays'; // метка задачи фоновой проверки

/**
 * Открывает (и при первом запуске создаёт) базу IndexedDB,
 * в которой Service Worker хранит свою копию списка людей.
 */
function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);

    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE_NAME);
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Сохраняет список людей (присланный со страницы через postMessage)
 * в IndexedDB, чтобы он был доступен даже когда сайт закрыт.
 */
async function savePeople(people) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(people, 'list');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Читает сохранённый список людей из IndexedDB.
 * Если данных ещё нет — возвращает пустой массив.
 */
async function loadPeople() {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const request = tx.objectStore(STORE_NAME).get('list');
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Считает, сколько дней осталось до следующего дня рождения человека.
 * Логика полностью повторяет функцию daysUntilBirthday() из index.html,
 * чтобы уведомления совпадали с тем, что видно на экране приложения.
 */
function daysUntilBirthday(dateStr) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const birthDate = new Date(dateStr);
  let nextBirthday = new Date(today.getFullYear(), birthDate.getMonth(), birthDate.getDate());
  nextBirthday.setHours(0, 0, 0, 0);

  if (nextBirthday < today) {
    nextBirthday.setFullYear(today.getFullYear() + 1);
  }

  const diffMs = nextBirthday - today;
  return Math.round(diffMs / (1000 * 60 * 60 * 24));
}

/**
 * Главная фоновая проверка: смотрит весь список людей и показывает
 * стандартное системное уведомление для каждого, у кого именно сегодня
 * день рождения.
 */
async function checkBirthdaysAndNotify() {
  const people = await loadPeople();
  const todayPeople = people.filter((person) => daysUntilBirthday(person.date) === 0);

  for (const person of todayPeople) {
    await self.registration.showNotification('🎉 День рождения сегодня!', {
      body: `У ${person.name} сегодня день рождения. Не забудьте поздравить!`,
      tag: `birthday-${person.id}`, // не даёт показать одно и то же уведомление дважды за день
      requireInteraction: false
    });
  }
}

/* ===================== СТАНДАРТНЫЕ СОБЫТИЯ SERVICE WORKER'А ===================== */

// Устанавливается сразу, не дожидаясь закрытия всех старых вкладок сайта
self.addEventListener('install', () => {
  self.skipWaiting();
});

// Начинает управлять страницей сразу после активации
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

/**
 * Страница присылает сюда актуальный список людей (после каждого
 * добавления/удаления), чтобы Service Worker знал, кого проверять,
 * даже если сайт в этот момент закрыт.
 */
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SYNC_PEOPLE') {
    event.waitUntil(savePeople(event.data.people));
  }
});

/**
 * Periodic Background Sync — браузер сам вызывает этот код примерно раз
 * в сутки, даже если сайт не открыт. Поддерживается пока только в
 * Chrome/Edge на Android и только если сайт установлен как PWA на главный
 * экран (плюс сайт должен отдаваться по HTTPS).
 */
self.addEventListener('periodicsync', (event) => {
  if (event.tag === PERIODIC_SYNC_TAG) {
    event.waitUntil(checkBirthdaysAndNotify());
  }
});

/**
 * Обычный (одноразовый) Background Sync — резервный вариант там, где
 * Periodic Background Sync недоступен. Может быть запущен, например,
 * при восстановлении интернет-соединения.
 */
self.addEventListener('sync', (event) => {
  if (event.tag === PERIODIC_SYNC_TAG) {
    event.waitUntil(checkBirthdaysAndNotify());
  }
});

/**
 * Клик по уведомлению открывает вкладку с приложением
 * (или переключает на уже открытую).
 */
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window' }).then((clientsArr) => {
      const existing = clientsArr.find((c) => c.url.includes(self.location.origin));
      if (existing) {
        return existing.focus();
      }
      return self.clients.openWindow('./');
    })
  );
});
