package replay

import (
	"bufio"
	"errors"
	"fmt"
	"io"
)

// MaxEvent bounds one rrweb event once decoded. A full snapshot of a very
// large page is a few tens of megabytes; anything bigger is refused rather
// than held in memory.
const MaxEvent = 64 << 20

// ErrEventTooLarge is returned by ScanArray for an element over the limit.
var ErrEventTooLarge = errors.New("event over the size limit")

// ScanArray reads a JSON array from r and calls fn with each element's raw
// bytes, one at a time, so an array never has to be held whole. The slice
// passed to fn is reused after fn returns. ScanArray checks the array's
// structure (brackets, strings, commas); fn should check each element
// itself (json.Valid or json.Unmarshal) before trusting it.
func ScanArray(r io.Reader, maxElem int, fn func(elem []byte) error) error {
	br, ok := r.(*bufio.Reader)
	if !ok {
		br = bufio.NewReaderSize(r, 32<<10)
	}
	c, err := skipSpace(br)
	if err != nil {
		return fmt.Errorf("events are not a JSON array: %w", eof(err))
	}
	if c != '[' {
		return errors.New("events are not a JSON array")
	}
	var elem []byte
	first := true
	for {
		c, err := skipSpace(br)
		if err != nil {
			return fmt.Errorf("events array: %w", eof(err))
		}
		if c == ']' && first {
			return trailing(br)
		}
		first = false
		elem = elem[:0]
		depth, inString, escaped := 0, false, false
	scan:
		for {
			if inString {
				switch {
				case escaped:
					escaped = false
				case c == '\\':
					escaped = true
				case c == '"':
					inString = false
				}
			} else {
				switch c {
				case '"':
					inString = true
				case '{', '[':
					depth++
				case '}', ']':
					if depth == 0 {
						if c == '}' {
							return errors.New("events array: unbalanced }")
						}
						break scan // the array's own ]
					}
					depth--
				case ',':
					if depth == 0 {
						break scan
					}
				}
			}
			if len(elem) >= maxElem {
				return ErrEventTooLarge
			}
			elem = append(elem, c)
			if c, err = br.ReadByte(); err != nil {
				return fmt.Errorf("events array: %w", eof(err))
			}
		}
		// c is the , or ] after the element.
		for len(elem) > 0 && isSpace(elem[len(elem)-1]) {
			elem = elem[:len(elem)-1]
		}
		if len(elem) == 0 {
			return errors.New("events array: empty element")
		}
		if err := fn(elem); err != nil {
			return err
		}
		if c == ']' {
			return trailing(br)
		}
	}
}

func isSpace(c byte) bool { return c == ' ' || c == '\t' || c == '\n' || c == '\r' }

func skipSpace(br *bufio.Reader) (byte, error) {
	for {
		c, err := br.ReadByte()
		if err != nil || !isSpace(c) {
			return c, err
		}
	}
}

func trailing(br *bufio.Reader) error {
	if _, err := skipSpace(br); err != io.EOF {
		if err == nil {
			return errors.New("events array: data after the closing bracket")
		}
		return err
	}
	return nil
}

func eof(err error) error {
	if err == io.EOF {
		return io.ErrUnexpectedEOF
	}
	return err
}
