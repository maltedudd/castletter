import Link from 'next/link'

export default function ImpressumPage() {
  return (
    <div className="min-h-screen container max-w-2xl mx-auto px-4 py-12">
      <Link href="/" className="text-sm text-muted-foreground hover:text-primary transition-colors mb-6 inline-block">
        ← Zur Startseite
      </Link>
      <h1 className="text-3xl font-bold mb-8">Impressum</h1>

      <div className="prose prose-sm max-w-none space-y-6 text-sm leading-relaxed">
        <section>
          <h2 className="text-lg font-semibold mb-2">Angaben gemäß § 5 TMG</h2>
          <p>
            JIPIDO MEDIA UG (haftungsbeschränkt)<br />
            Große Brunnenstraße 127a<br />
            22763 Hamburg
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold mb-2">Handelsregister</h2>
          <p>
            Registergericht: Hamburg<br />
            Registernummer: HRB 136425
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold mb-2">Vertreten durch</h2>
          <p>Malte Dudd</p>
        </section>

        <section>
          <h2 className="text-lg font-semibold mb-2">Kontakt</h2>
          <p>
            Telefon: 040 41482955<br />
            Telefax: 040 38017854115<br />
            E-Mail: <a href="mailto:hello@jipido.de" className="underline hover:no-underline">hello@jipido.de</a>
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold mb-2">Umsatzsteuer-ID</h2>
          <p>
            Umsatzsteuer-Identifikationsnummer gemäß § 27a Umsatzsteuergesetz:<br />
            DE300253232
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold mb-2">Verantwortlich für den Inhalt nach § 55 Abs. 2 RStV</h2>
          <p>
            Malte Dudd<br />
            Große Brunnenstraße 127a<br />
            22763 Hamburg
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold mb-2">Haftungsausschluss</h2>
          <h3 className="font-medium mt-4 mb-1">Haftung für Inhalte</h3>
          <p>
            Die Inhalte unserer Seiten wurden mit größter Sorgfalt erstellt. Für die Richtigkeit,
            Vollständigkeit und Aktualität der Inhalte können wir jedoch keine Gewähr übernehmen.
            Als Diensteanbieter sind wir gemäß § 7 Abs. 1 TMG für eigene Inhalte auf diesen Seiten
            nach den allgemeinen Gesetzen verantwortlich. Nach §§ 8 bis 10 TMG sind wir als
            Diensteanbieter jedoch nicht verpflichtet, übermittelte oder gespeicherte fremde
            Informationen zu überwachen oder nach Umständen zu forschen, die auf eine rechtswidrige
            Tätigkeit hinweisen. Verpflichtungen zur Entfernung oder Sperrung der Nutzung von
            Informationen nach den allgemeinen Gesetzen bleiben hiervon unberührt. Eine
            diesbezügliche Haftung ist jedoch erst ab dem Zeitpunkt der Kenntnis einer konkreten
            Rechtsverletzung möglich. Bei Bekanntwerden von entsprechenden Rechtsverletzungen werden
            wir diese Inhalte umgehend entfernen.
          </p>
          <h3 className="font-medium mt-4 mb-1">Haftung für Links</h3>
          <p>
            Unser Angebot enthält Links zu externen Webseiten Dritter, auf deren Inhalte wir keinen
            Einfluss haben. Deshalb können wir für diese fremden Inhalte auch keine Gewähr
            übernehmen. Für die Inhalte der verlinkten Seiten ist stets der jeweilige Anbieter oder
            Betreiber der Seiten verantwortlich. Die verlinkten Seiten wurden zum Zeitpunkt der
            Verlinkung auf mögliche Rechtsverstöße überprüft. Rechtswidrige Inhalte waren zum
            Zeitpunkt der Verlinkung nicht erkennbar. Eine permanente inhaltliche Kontrolle der
            verlinkten Seiten ist jedoch ohne konkrete Anhaltspunkte einer Rechtsverletzung nicht
            zumutbar. Bei Bekanntwerden von Rechtsverletzungen werden wir derartige Links umgehend
            entfernen.
          </p>
          <h3 className="font-medium mt-4 mb-1">Urheberrecht</h3>
          <p>
            Die durch die Seitenbetreiber erstellten Inhalte und Werke auf diesen Seiten unterliegen
            dem deutschen Urheberrecht. Die Vervielfältigung, Bearbeitung, Verbreitung und jede Art
            der Verwertung außerhalb der Grenzen des Urheberrechtes bedürfen der schriftlichen
            Zustimmung des jeweiligen Autors bzw. Erstellers. Downloads und Kopien dieser Seite sind
            nur für den privaten, nicht kommerziellen Gebrauch gestattet. Soweit die Inhalte auf
            dieser Seite nicht vom Betreiber erstellt wurden, werden die Urheberrechte Dritter
            beachtet. Insbesondere werden Inhalte Dritter als solche gekennzeichnet. Sollten Sie
            trotzdem auf eine Urheberrechtsverletzung aufmerksam werden, bitten wir um einen
            entsprechenden Hinweis. Bei Bekanntwerden von Rechtsverletzungen werden wir derartige
            Inhalte umgehend entfernen.
          </p>
        </section>
      </div>
    </div>
  )
}
