// Adds an entry to the event log on the page, optionally applying a specified
// CSS class.
//
// This is a Safari-compatible fork of the Chrome WebTransport sample. The
// WebTransport Web API itself is standardized (WHATWG Fetch/Streams-based),
// so the stream/datagram code below is identical for Chrome and Safari.
// The differences that matter in practice are:
//
//   1. Safari didn't ship WebTransport at all until version 26.4, so we
//      feature-detect instead of assuming the global exists.
//   2. Safari's `WebTransportError` frequently has an empty `message`. We
//      pull in `source` / `streamErrorCode` (when present) and fall back to
//      a helpful hint instead of showing a blank error.
//   3. The spec changed the datagram-sending API in March 2025:
//      `datagrams.writable` is deprecated/non-standard and Safari only ever
//      implemented the replacement, `datagrams.createWritable()`. Chrome and
//      Firefox still also expose the legacy `writable` property, so we
//      prefer `createWritable()` and fall back to `writable` when it's
//      missing.

let currentTransport, streamNumber, currentTransportDatagramWriter;

// Feature-detect WebTransport support and disable the UI with an explanatory
// message if it's missing (e.g. Safari < 26.4, or any browser with the API
// behind a flag).
function checkWebTransportSupport() {
  const banner = document.getElementById('support-banner');
  if (typeof WebTransport === 'undefined') {
    banner.textContent =
        'WebTransport is not available in this browser. It requires ' +
        'Safari 26.4+ (macOS/iOS), a recent Chrome/Edge, or Firefox with ' +
        'the feature enabled.';
    banner.classList.remove('hidden');
    banner.classList.add('banner-error');
    document.getElementById('connect').disabled = true;
    return false;
  }
  return true;
}

// Returns a WritableStream for outgoing datagrams, preferring the current
// spec's `createWritable()` (Safari-only today) over the deprecated
// `writable` property (Chrome/Firefox today).
function getDatagramWritable(transport) {
  return typeof transport.datagrams.createWritable === 'function' ?
      transport.datagrams.createWritable() :
      transport.datagrams.writable;
}

// Produces a readable message from a thrown error, working around Safari's
// WebTransportError sometimes having an empty `message`.
function describeError(e) {
  if (e && e.message) {
    return e.message;
  }
  if (e && typeof e === 'object') {
    const parts = [];
    if (e.name) parts.push(e.name);
    if (e.source) parts.push(`source=${e.source}`);
    if (typeof e.streamErrorCode === 'number') {
      parts.push(`streamErrorCode=${e.streamErrorCode}`);
    }
    if (parts.length) return parts.join(' ');
  }
  return String(e);
}

// "Connect" button handler.
async function connect() {
  if (!checkWebTransportSupport()) {
    return;
  }

  const url = document.getElementById('url').value;

  let transport;
  try {
    transport = new WebTransport(url);
    addToEventLog('Initiating connection...');
  } catch (e) {
    addToEventLog('Failed to create connection object. ' + describeError(e), 'error');
    return;
  }

  try {
    await transport.ready;
    addToEventLog('Connection ready.');
  } catch (e) {
    addToEventLog('Connection failed. ' + describeError(e), 'error');
    try {
      transport.close();
    } catch (_) {
      // Ignore; transport may already be in a bad state.
    }
    return;
  }

  transport.closed
      .then(() => {
        addToEventLog('Connection closed normally.');
      })
      .catch((e) => {
        addToEventLog('Connection closed abruptly. ' + describeError(e), 'error');
      });

  currentTransport = transport;
  streamNumber = 1;
  try {
    currentTransportDatagramWriter = getDatagramWritable(transport).getWriter();
    addToEventLog('Datagram writer ready.');
  } catch (e) {
    addToEventLog('Sending datagrams not supported: ' + describeError(e), 'error');
    return;
  }
  readDatagrams(transport);
  acceptUnidirectionalStreams(transport);
  document.forms.sending.elements.send.disabled = false;
  document.getElementById('connect').disabled = true;
}

// "Send data" button handler.
async function sendData() {
  let form = document.forms.sending.elements;
  let encoder = new TextEncoder();
  let rawData = sending.data.value;
  let data = encoder.encode(rawData);
  let transport = currentTransport;
  try {
    switch (form.sendtype.value) {
      case 'datagram':
        // Datagram delivery is unreliable, so wait for the writer to be
        // ready before writing rather than letting writes pile up.
        await currentTransportDatagramWriter.ready;
        await currentTransportDatagramWriter.write(data);
        addToEventLog('Sent datagram: ' + rawData);
        break;
      case 'unidi': {
        let stream = await transport.createUnidirectionalStream();
        let writer = stream.getWriter();
        await writer.write(data);
        await writer.close();
        addToEventLog('Sent a unidirectional stream with data: ' + rawData);
        break;
      }
      case 'bidi': {
        let stream = await transport.createBidirectionalStream();
        let number = streamNumber++;
        readFromIncomingStream(stream, number);

        let writer = stream.writable.getWriter();
        await writer.write(data);
        await writer.close();
        addToEventLog(
            'Opened bidirectional stream #' + number +
            ' with data: ' + rawData);
        break;
      }
    }
  } catch (e) {
    addToEventLog('Error while sending data: ' + describeError(e), 'error');
  }
}

// Reads datagrams from |transport| into the event log until EOF is reached.
async function readDatagrams(transport) {
  let reader;
  try {
    reader = transport.datagrams.readable.getReader();
    addToEventLog('Datagram reader ready.');
  } catch (e) {
    addToEventLog('Receiving datagrams not supported: ' + describeError(e), 'error');
    return;
  }
  let decoder = new TextDecoder();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        addToEventLog('Done reading datagrams!');
        return;
      }
      let data = decoder.decode(value);
      addToEventLog('Datagram received: ' + data);
    }
  } catch (e) {
    addToEventLog('Error while reading datagrams: ' + describeError(e), 'error');
  }
}

async function acceptUnidirectionalStreams(transport) {
  let reader = transport.incomingUnidirectionalStreams.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        addToEventLog('Done accepting unidirectional streams!');
        return;
      }
      let stream = value;
      let number = streamNumber++;
      addToEventLog('New incoming unidirectional stream #' + number);
      readFromIncomingStream(stream, number);
    }
  } catch (e) {
    addToEventLog('Error while accepting streams: ' + describeError(e), 'error');
  }
}

async function readFromIncomingStream(stream, number) {
  // TextDecoderStream has been available in Safari since 14.1, so this is
  // safe to use unconditionally.
  let decoder = new TextDecoderStream();
  let reader = stream.pipeThrough(decoder).getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        addToEventLog('Stream #' + number + ' closed');
        return;
      }
      let data = value;
      addToEventLog('Received data on stream #' + number + ': ' + data);
    }
  } catch (e) {
    addToEventLog(
        'Error while reading from stream #' + number + ': ' + describeError(e),
        'error');
  }
}

function addToEventLog(text, severity = 'info') {
  let log = document.getElementById('event-log');
  let mostRecentEntry = log.lastElementChild;
  let entry = document.createElement('li');
  entry.innerText = text;
  entry.className = 'log-' + severity;
  log.appendChild(entry);

  // If the most recent entry in the log was visible, scroll the log to the
  // newly added element.
  if (mostRecentEntry != null &&
      mostRecentEntry.getBoundingClientRect().top <
          log.getBoundingClientRect().bottom) {
    entry.scrollIntoView();
  }
}

document.addEventListener('DOMContentLoaded', () => {
  checkWebTransportSupport();
});
