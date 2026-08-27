class Livepage < Formula
  desc "Think on the live web: Chrome extension, For you feed, and save importer"
  homepage "https://github.com/abhushansahu/livepage-exploration"
  version "0.1.0"
  head "https://github.com/abhushansahu/livepage-exploration.git", branch: "main"
  url "https://github.com/abhushansahu/livepage-exploration.git", branch: "main"

  def install
    libexec.install Dir["*"]
    (bin/"livepage").write <<~EOS
      #!/bin/bash
      exec "#{libexec}/bin/livepage" "$@"
    EOS
    chmod 0755, bin/"livepage"
    chmod 0755, libexec/"bin/livepage"
  end

  def caveats
    <<~EOS
      Run LivePage with:

        livepage

      That opens a dedicated Chrome profile with the extension loaded.
      Sign into X, Reddit, and YouTube once in that window if you want
      Pull saves. After that, livepage is the daily command.

      livepage dashboard   For you feed
      livepage demo        demo article + feed
      livepage stop        stop the local server
    EOS
  end

  test do
    assert_match "LivePage", shell_output("#{bin}/livepage help")
  end
end
