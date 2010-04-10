#!/bin/sh

# Set up variables
GMMAX=${1-0}
GMMIN=${2-8}
GMREL=${3-0}
GMBUILD=`date +"%Y%m%d"`
GMNAME=greasemonkey
GMVER="$GMMAX.$GMMIN.$GMBUILD.$GMREL"
GMXPI="$GMNAME-$GMVER.xpi"

# Copy base structure to a temporary build directory and change to it
echo "Creating working directory ..."
rm -rf build
mkdir build
cp -r \
	chrome.manifest components content defaults install.rdf license.txt locale \
	build/
cd build

echo "Gathering all locales into chrome.manifest ..."
GMLOC="en-US"
for entry in locale/*; do
  entry=`basename $entry`
  if [ $entry != en-US ]; then
    echo "locale  $GMNAME  $entry  locale/$entry/" >> chrome.manifest
    GMLOC="$GMLOC, $entry"
  fi
done

echo "Patching install.rdf version ..."
sed -ie "s!<em:version>.*</em:version>!<em:version>$GMVER</em:version>!" \
  install.rdf
# BSD sed -i takes a mandatory backup file suffix parameter, here "e" -- which
# other seds will treat as the harmless "sed command follows". Nuke the backup
# file, if created, so mac builds won't contain that junk file:
rm -f install.rdfe

echo "Cleaning up unwanted files ..."
find . -depth -name '*~' -exec rm -rf "{}" \;
find . -depth -name '#*' -exec rm -rf "{}" \;

echo "Creating $GMXPI ..."
zip -qr9X "../$GMXPI" *

echo "Cleaning up temporary files ..."
cd ..
rm -rf build
