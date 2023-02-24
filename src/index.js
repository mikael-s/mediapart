process.env.SENTRY_DSN =
  process.env.SENTRY_DSN ||
  'https://56c58c44aec84354b340322da288e886@sentry.cozycloud.cc/60'

const {
  BaseKonnector,
  requestFactory,
  signin,
  saveBills,
  log
} = require('cozy-konnector-libs')

const moment = require('moment')
const USER_AGENT =
  'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:62.0) Gecko/20100101 Firefox/62.0 Cozycloud'
const request = requestFactory({
  // the debug mode shows all the details about http request and responses. Very usefull for
  // debugging but very verbose. That is why it is commented out by default
  // debug: true,
  // activates [cheerio](https://cheerio.js.org/) parsing on each page
  cheerio: true,
  // If cheerio is activated do not forget to deactivate json parsing (which is activated by
  // default in cozy-konnector-libs
  json: false,
  // this allows request-promise to keep cookies between requests
  jar: true,
  headers: {
    'User-Agent': USER_AGENT
  }
})

module.exports = new BaseKonnector(start)

async function start(fields) {
  log('info', 'Authenticating ...')
  await authenticate(fields.login, fields.password)
  log('info', 'Successfully logged in')
  log('info', 'Getting the session id')
  const $compte = await request('https://moncompte.mediapart.fr/')
  log('info', 'Parsing list of documents')
  const documents = await parseDocuments($compte)
  log('debug', documents, 'docs')
  log('info', 'Saving data to Cozy')
  await saveBills(documents, fields.folderPath, {
    keys: ['vendor', 'billId'], // deduplication keys
    identifiers: ['mediapart'] // bank operations
  })
}

function authenticate(name, password) {
  return signin({
    url: 'https://www.mediapart.fr/login',
    formSelector: '#logFormEl',
    formData: { name, password },
    // the validate function will check if
    validate: (statusCode, $) => {
      // The login in toscrape.com always works excepted when no password is set
      if ($(`a[href='/logout']`).length === 1) {
        return true
      } else {
        // cozy-konnector-libs has its own logging function which format these logs with colors in
        // standalone and dev mode and as JSON in production mode
        log('error', 'No logout button found after login')
        return false
      }
    }
  })
}

/* This function scrape differents tables found
   About html:
     - one <div> with <li> contains  bills 
     - When account is old and not use anymore, bills are concat in only a <tr> table [Not sure that's still the case]
     - When some gift card(for mediapart or courrier international is used, some line can
     have no pdf and no price
   Strategy :
     We try to scrape about all <li> and all <tr> in all table found.
     Most known errors was about <tr> being not a bill line scrapable (header, gift card)
     Bad <tr> part are avoid by their missing 'valign: middle' or their missing pdf link
*/
function parseDocuments($) {
  // Common constantes
  const vendor = 'Mediapart'
  const date = new Date()
  const version = 1
  const metadata = { date, version }

  const listOfRecents = $('#billing-list li')
    .filter(function(idx, li) {
      return $(li).find('a').length !== 0 // Throw line without pdf link
    })
    .map(function(idx, li) {
      try {
        const re = /.*(\d\d\/\d\d\/\d\d\d\d).*(\d\d\/\d\d\/\d\d\d\d)[\s\S]*\s+(\d+(?:[,.]\d+)?)\s+(\S+).*/m
        const [, start, end, price, currency] = $(li)
          .text()
          .match(re)
        const oStart = moment.utc(start, 'DD/MM/YYYY')
        const oEnd = moment.utc(end, 'DD/MM/YYYY')
        const startDate = oStart.format('YYYY-MM-DD')
        const endDate = oEnd.format('YYYY-MM-DD')
        const date = oEnd.toDate()
        const href = $('a', li)
          .first()
          .attr('href')
        const fileurl = `https://moncompte.mediapart.fr${href}`
        const billId = href.match(/facture\/([^/]+)\//)[1]
        const title = `Mediapart ${billId} ${startDate} - ${endDate}`
        const filename = `mediapart_${billId}_${startDate}_${endDate}.pdf`
        const amount = parseFloat(price.replace(',', '.'))
        return {
          title,
          metadata,
          date,
          startDate,
          endDate,
          amount,
          vendor,
          billId,
          currency,
          filename,
          fileurl,
          requestOptions: {
            headers: {
              'User-Agent': USER_AGENT
            }
          }
        }
      } catch (err) {
        log('warn', 'Impossible to parse one line')
        log('warn', JSON.stringify(err))
      }
    })
    .get()
  log('debug', `${listOfRecents.length} bills found in <li> style table`)


  return listOfRecents
}
